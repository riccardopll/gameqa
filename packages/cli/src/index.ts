#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toJSONSchema } from "zod";
import {
    agentDecisionSchema,
    decisionRequestSchema,
    configSchema,
    reportSchema,
    runnerCompleteSchema,
    runnerJobSchema,
    sdkEventBatchSchema,
    type AgentDecision,
    type DecisionRequest,
    type Config,
    type Report,
    type RunnerComplete,
    type RunnerJob,
    type SdkEvent,
} from "gameqa/shared";

type CliOptions = {
    cwd: string;
    env: NodeJS.ProcessEnv;
    argv: string[];
};

type RunOptions = {
    agentId: string;
    url: string;
    configPath?: string;
};

type CommandResult = {
    code: number;
    stdout: string;
    stderr: string;
};

type BridgeState = {
    cwd: string;
    agent: Config["agents"][number];
    runDir: string;
    hostRunDir: string;
    runId: string;
    sessionId: string;
    events: SdkEvent[];
    decisions: AgentDecision[];
    completed: RunnerComplete | null;
    codexCommand: string;
};

const defaultConfigName = "gameqa.config.ts";
const defaultRunnerImage = "ghcr.io/riccardopll/gameqa-browser-runner:latest";

const starterConfig = `export default {
  run: {
    outputDir: ".gameqa/runs",
    maxTurns: 20,
    timeoutSeconds: 300,
  },
  agents: [
    {
      id: "codex-qa",
      adapter: "codex",
      persona: "You are a rigorous game QA tester. Find broken state, unclear feedback, and edge-case failures.",
    },
  ],
}
`;

const createId = (prefix: string) =>
    `${prefix}_${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;

const print = (message = "") => {
    process.stdout.write(`${message}\n`);
};

const readStdin = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
    });
    response.end(JSON.stringify(body));
};

const parseJson = (value: string) => {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
};

const pathExists = async (filePath: string) => {
    await access(filePath);
    return true;
};

export const parseArgs = (argv: string[]) => {
    const [command, ...rest] = argv;
    const flags = new Map<string, string | true>();

    for (let index = 0; index < rest.length; index += 1) {
        const value = rest[index];
        if (!value?.startsWith("--")) {
            continue;
        }

        const key = value.slice(2);
        const next = rest[index + 1];
        if (next && !next.startsWith("--")) {
            flags.set(key, next);
            index += 1;
        } else {
            flags.set(key, true);
        }
    }

    return { command, flags };
};

const requireFlag = (flags: Map<string, string | true>, name: string) => {
    const value = flags.get(name);
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Missing required --${name}`);
    }

    return value;
};

export const dockerReachableUrl = (input: string) => {
    const url = new URL(input);
    if (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "0.0.0.0" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]"
    ) {
        url.hostname = "host.docker.internal";
    }

    return url.toString();
};

export const loadConfig = async (cwd: string, configPath = defaultConfigName) => {
    const resolved = path.resolve(cwd, configPath);
    const imported = (await import(
        `${pathToFileURL(resolved).href}?t=${Date.now()}`
    )) as {
        default?: unknown;
    };
    return configSchema.parse(imported.default);
};

export const selectAgent = (config: Config, agentId: string) => {
    const agent = config.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
        throw new Error(`Unknown GameQA agent: ${agentId}`);
    }

    return agent;
};

const runCommand = async (
    command: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
) =>
    new Promise<CommandResult>((resolve) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("close", (code) => {
            resolve({
                code: code ?? 1,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
            });
        });
    });

const dockerCommand = (env: NodeJS.ProcessEnv) => env.GAMEQA_DOCKER_COMMAND ?? "docker";

export const buildRunnerImageArgs = (input: {
    image: string;
    dockerfile: string;
    context: string;
}) => ["build", "-f", input.dockerfile, "-t", input.image, input.context];

export const pullRunnerImageArgs = (image: string) => ["pull", image];

export const runRunnerImageArgs = (input: {
    image: string;
    runDir: string;
    job: RunnerJob;
}) => [
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${input.runDir}:/gameqa-run`,
    "-e",
    `GAMEQA_RUNNER_JOB=${JSON.stringify(input.job)}`,
    input.image,
];

const localRunnerBuild = async (cwd: string, env: NodeJS.ProcessEnv) => {
    const dockerfile = path.resolve(
        cwd,
        env.GAMEQA_RUNNER_DOCKERFILE ?? "packages/browser-runner/Dockerfile",
    );
    const context = path.resolve(cwd, env.GAMEQA_RUNNER_CONTEXT ?? ".");

    if (!(await pathExists(dockerfile).catch(() => false))) {
        return null;
    }

    return { dockerfile, context };
};

export const ensureRunnerImage = async (cwd: string, env: NodeJS.ProcessEnv) => {
    const image = env.GAMEQA_RUNNER_IMAGE ?? defaultRunnerImage;
    const docker = dockerCommand(env);
    const inspect = await runCommand(docker, ["image", "inspect", image], { cwd, env });
    if (inspect.code === 0) {
        return image;
    }

    const localBuild = await localRunnerBuild(cwd, env);
    if (localBuild) {
        const build = await runCommand(
            docker,
            buildRunnerImageArgs({ image, ...localBuild }),
            { cwd, env },
        );
        if (build.code !== 0) {
            throw new Error(
                `Unable to build GameQA browser runner: ${build.stderr || build.stdout}`,
            );
        }
        return image;
    }

    const pull = await runCommand(docker, pullRunnerImageArgs(image), { cwd, env });
    if (pull.code !== 0) {
        throw new Error(
            `Unable to pull GameQA browser runner: ${pull.stderr || pull.stdout}`,
        );
    }

    return image;
};

const writeJson = async (filePath: string, value: unknown) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const reportMarkdown = (report: Report) => {
    const findings =
        report.findings.length === 0
            ? "No findings reported."
            : report.findings
                  .map(
                      (finding) =>
                          `## ${finding.title}\n\nSeverity: ${finding.severity}\n\n${finding.description}\n\nEvidence: ${finding.evidence}\n\nRecommendation: ${finding.recommendation}`,
                  )
                  .join("\n\n");
    const recommendations =
        report.recommendations.length === 0
            ? ""
            : `\n\n## Recommendations\n\n${report.recommendations.map((item) => `- ${item}`).join("\n")}`;

    return `# GameQA Report\n\n${report.summary}\n\nConfidence: ${report.confidence}\n\n${findings}${recommendations}\n`;
};

const makePrompt = (title: string, sections: Record<string, unknown>) =>
    [
        title,
        "",
        ...Object.entries(sections).flatMap(([heading, value]) => [
            `## ${heading}`,
            typeof value === "string" ? value : JSON.stringify(value, null, 2),
            "",
        ]),
    ].join("\n");

export const buildCodexArgs = (input: {
    cwd: string;
    schemaPath: string;
    outputPath: string;
    promptPath: string;
    imagePath?: string;
}) => [
    "exec",
    "--cd",
    input.cwd,
    "--sandbox",
    "read-only",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.outputPath,
    ...(input.imagePath ? ["--image", input.imagePath] : []),
    "-",
];

const runCodexJson = async (input: {
    cwd: string;
    runDir: string;
    kind: "decision" | "report";
    prompt: string;
    schema: unknown;
    imagePath?: string;
    command: string;
}) => {
    const dir = path.join(input.runDir, "codex", `${input.kind}s`);
    await mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const promptPath = path.join(dir, `${timestamp}.md`);
    const outputPath = path.join(dir, `${timestamp}.json`);
    const schemaPath = path.join(dir, `${timestamp}.schema.json`);
    await writeFile(promptPath, input.prompt, "utf8");
    await writeJson(schemaPath, input.schema);

    const args = buildCodexArgs({
        cwd: input.cwd,
        schemaPath,
        outputPath,
        promptPath,
        imagePath: input.imagePath,
    });
    const result = await runCommand(input.command, args, {
        cwd: input.cwd,
        env: process.env,
    });

    if (result.code !== 0) {
        throw new Error(`Codex ${input.kind} failed: ${result.stderr || result.stdout}`);
    }

    return parseJson(await readFile(outputPath, "utf8"));
};

const decisionPrompt = (
    agent: Config["agents"][number],
    request: DecisionRequest,
    events: SdkEvent[],
    decisions: AgentDecision[],
) =>
    makePrompt("Choose the next GameQA action.", {
        Persona: agent.persona,
        Rules: "Return one schema-valid JSON decision. Use SDK controller actions or driver goals. Do not ask for code edits. Finish when enough evidence has been collected.",
        Inspection: request.inspection,
        "Visible Text": request.evidence.visibleText,
        "Recent SDK Events": events.slice(-30),
        "Previous Decisions": decisions,
    });

const reportPrompt = (state: BridgeState) =>
    makePrompt("Write the final GameQA report.", {
        Persona: state.agent.persona,
        Rules: "Return schema-valid JSON. Focus on game behavior, SDK state, visible evidence, video/screenshots, console/runtime failures, and concrete recommendations.",
        Events: state.events,
        Decisions: state.decisions,
        Completion: state.completed,
        Artifacts: {
            video: "video.webm",
            trace: "trace.zip",
            screenshots: "screenshots/",
        },
    });

const handleDecision = async (state: BridgeState, body: unknown) => {
    const request = decisionRequestSchema.parse(body);
    const hostScreenshotPath = path.join(
        state.hostRunDir,
        path.relative(state.runDir, request.evidence.screenshotPath),
    );
    const payload = await runCodexJson({
        cwd: state.cwd,
        runDir: state.hostRunDir,
        kind: "decision",
        prompt: decisionPrompt(state.agent, request, state.events, state.decisions),
        schema: toJSONSchema(agentDecisionSchema),
        imagePath: hostScreenshotPath,
        command: state.codexCommand,
    });
    const decision = agentDecisionSchema.parse(payload);
    state.decisions.push(decision);
    await writeJson(path.join(state.hostRunDir, "actions.json"), state.decisions);

    return decision;
};

const handleComplete = async (state: BridgeState, body: unknown) => {
    const complete = runnerCompleteSchema.parse(body);
    state.completed = complete;
    await writeJson(path.join(state.hostRunDir, "session.json"), complete);
};

export const createBridgeServer = async (state: BridgeState) => {
    const server = createServer((request, response) => {
        void (async () => {
            if (request.method === "OPTIONS") {
                sendJson(response, 204, {});
                return;
            }

            if (request.method !== "POST") {
                sendJson(response, 404, { error: "Not found" });
                return;
            }

            const url = new URL(request.url ?? "/", "http://gameqa.local");
            const body = parseJson(await readStdin(request));

            try {
                if (url.pathname === "/sdk/events") {
                    const batch = sdkEventBatchSchema.parse(body);
                    if (batch.sessionId !== state.sessionId) {
                        sendJson(response, 400, { error: "Invalid session" });
                        return;
                    }

                    state.events.push(...batch.events);
                    await writeJson(
                        path.join(state.hostRunDir, "events.json"),
                        state.events,
                    );
                    sendJson(response, 200, { ok: true, accepted: batch.events.length });
                    return;
                }

                if (url.pathname === "/decision") {
                    const decision = await handleDecision(state, body);
                    sendJson(response, 200, { ok: true, decision });
                    return;
                }

                if (url.pathname === "/complete") {
                    await handleComplete(state, body);
                    sendJson(response, 200, { ok: true });
                    return;
                }

                sendJson(response, 404, { error: "Bridge route not found" });
            } catch (error) {
                sendJson(response, 500, {
                    error:
                        error instanceof Error ? error.message : "Bridge request failed",
                });
            }
        })();
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "0.0.0.0", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Unable to start GameQA bridge");
    }

    return {
        origin: `http://host.docker.internal:${address.port}`,
        localOrigin: `http://localhost:${address.port}`,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
};

const runDockerRunner = async (
    job: RunnerJob,
    runDir: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
) => {
    const image = await ensureRunnerImage(cwd, env);
    const result = await runCommand(
        dockerCommand(env),
        runRunnerImageArgs({ image, runDir, job }),
        {
            cwd,
            env,
        },
    );

    if (result.code !== 0) {
        throw new Error(
            `GameQA browser runner failed: ${result.stderr || result.stdout}`,
        );
    }
};

const writeRunSummary = async (state: BridgeState, options: RunOptions) => {
    await writeJson(path.join(state.hostRunDir, "run.json"), {
        runId: state.runId,
        sessionId: state.sessionId,
        url: options.url,
        agent: state.agent,
        startedAt: new Date().toISOString(),
    });
};

const writeFinalReport = async (state: BridgeState) => {
    const payload = await runCodexJson({
        cwd: state.cwd,
        runDir: state.hostRunDir,
        kind: "report",
        prompt: reportPrompt(state),
        schema: toJSONSchema(reportSchema),
        command: state.codexCommand,
    });
    const report = reportSchema.parse(payload);
    await writeJson(path.join(state.hostRunDir, "report.json"), report);
    await writeFile(
        path.join(state.hostRunDir, "report.md"),
        reportMarkdown(report),
        "utf8",
    );
};

export const initConfig = async (cwd: string) => {
    const configPath = path.join(cwd, defaultConfigName);
    if (await pathExists(configPath).catch(() => false)) {
        throw new Error(`${defaultConfigName} already exists`);
    }

    await writeFile(configPath, starterConfig, "utf8");
    return configPath;
};

export const runSession = async (options: RunOptions, cli: CliOptions) => {
    const targetUrl = new URL(options.url);
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        throw new Error(`Target protocol ${targetUrl.protocol} is not allowed`);
    }

    const config = await loadConfig(cli.cwd, options.configPath);
    const agent = selectAgent(config, options.agentId);
    const runId = createId("run");
    const sessionId = createId("session");
    const hostRunDir = path.resolve(cli.cwd, config.run.outputDir, runId);
    await mkdir(hostRunDir, { recursive: true });

    const state: BridgeState = {
        cwd: cli.cwd,
        agent,
        runDir: "/gameqa-run",
        hostRunDir,
        runId,
        sessionId,
        events: [],
        decisions: [],
        completed: null,
        codexCommand: cli.env.GAMEQA_CODEX_COMMAND ?? "codex",
    };
    await writeRunSummary(state, options);
    const bridge = await createBridgeServer(state);

    try {
        const job = runnerJobSchema.parse({
            runId,
            sessionId,
            targetUrl: dockerReachableUrl(options.url),
            bridgeUrl: bridge.origin,
            maxTurns: config.run.maxTurns,
            timeoutSeconds: config.run.timeoutSeconds,
            workDir: "/gameqa-run",
        });
        await runDockerRunner(job, hostRunDir, cli.cwd, cli.env);
        if (!state.completed) {
            throw new Error("GameQA browser runner did not complete the session");
        }
        if (state.completed.status === "failed") {
            throw new Error(state.completed.error ?? "GameQA browser runner failed");
        }

        await writeFinalReport(state);
        return { runId, runDir: hostRunDir };
    } finally {
        await bridge.close();
    }
};

const runCli = async (cli: CliOptions) => {
    const { command, flags } = parseArgs(cli.argv);

    if (command === "init") {
        const configPath = await initConfig(cli.cwd);
        print(`Created ${path.relative(cli.cwd, configPath)}`);
        return;
    }

    if (command === "run") {
        const result = await runSession(
            {
                agentId: requireFlag(flags, "agent"),
                url: requireFlag(flags, "url"),
                configPath:
                    typeof flags.get("config") === "string"
                        ? (flags.get("config") as string)
                        : undefined,
            },
            cli,
        );
        print(`GameQA run complete: ${path.relative(cli.cwd, result.runDir)}`);
        return;
    }

    print("Usage:");
    print("  gameqa init");
    print("  gameqa run --agent <id> --url <url>");
};

const isCliEntrypoint = () => {
    const entry = process.argv[1];
    if (!entry) {
        return false;
    }

    try {
        return realpathSync(entry) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
};

if (isCliEntrypoint()) {
    void runCli({
        cwd: process.cwd(),
        env: process.env,
        argv: process.argv.slice(2),
    }).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
