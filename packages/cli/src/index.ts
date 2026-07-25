#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
} from "@gameqa/shared";
import packageJson from "../package.json" with { type: "json" };
import { runPiJson } from "./pi-adapter";
import { runCommand } from "./process";

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
  authToken: string;
  piCommand: string;
  agentTimeoutMs: number;
  env: NodeJS.ProcessEnv;
};

const packageVersion = packageJson.version;
const defaultConfigName = "gameqa.config.ts";
const defaultRunnerImage = `ghcr.io/riccardopll/gameqa-browser-runner:${packageVersion}`;

const starterConfig = `export default {
  run: {
    outputDir: ".gameqa/runs",
    maxTurns: 20,
    timeoutSeconds: 300,
    agentTimeoutSeconds: 120,
    settleMs: 250,
  },
  agents: [
    {
      id: "pi-qa",
      adapter: "pi",
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

class BridgeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const readStdin = async (request: IncomingMessage, maxBytes = 1_000_000) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new BridgeRequestError(`Request body exceeds ${maxBytes} bytes`, 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  });
  response.end(JSON.stringify(body));
};

const parseJson = (value: string) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new BridgeRequestError("Request body must be valid JSON", 400);
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
  const imported = (await import(`${pathToFileURL(resolved).href}?t=${Date.now()}`)) as {
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

const dockerCommand = (env: NodeJS.ProcessEnv) => env.GAMEQA_DOCKER_COMMAND ?? "docker";

export const buildRunnerImageArgs = (input: {
  image: string;
  dockerfile: string;
  context: string;
}) => ["build", "-f", input.dockerfile, "-t", input.image, input.context];

export const pullRunnerImageArgs = (image: string) => ["pull", image];

export const runRunnerImageArgs = (input: { image: string; runDir: string; job: RunnerJob }) => [
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
    const build = await runCommand(docker, buildRunnerImageArgs({ image, ...localBuild }), {
      cwd,
      env,
    });
    if (build.code !== 0) {
      throw new Error(`Unable to build GameQA browser runner: ${build.stderr || build.stdout}`);
    }
    return image;
  }

  const pull = await runCommand(docker, pullRunnerImageArgs(image), { cwd, env });
  if (pull.code !== 0) {
    throw new Error(`Unable to pull GameQA browser runner: ${pull.stderr || pull.stdout}`);
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

const decisionPrompt = (
  agent: Config["agents"][number],
  request: DecisionRequest,
  events: SdkEvent[],
  decisions: AgentDecision[],
) =>
  makePrompt("Choose the next GameQA action.", {
    Persona: agent.persona,
    Rules:
      "Return one schema-valid JSON decision. Use SDK controller actions or driver goals. Do not ask for code edits. Finish when enough evidence has been collected.",
    Inspection: request.inspection,
    "Visible Text": request.evidence.visibleText,
    "Recent SDK Events": events.slice(-30),
    "Previous Decisions": decisions,
  });

const reportPrompt = (
  state: BridgeState,
  evidence: { browserLog: string; screenshotText: Record<string, string> },
) =>
  makePrompt("Write the final GameQA report.", {
    Persona: state.agent.persona,
    Rules:
      "Return schema-valid JSON. Every finding must cite a real artifact path. Distinguish observed behavior from inference and give concrete recommendations.",
    Events: state.events,
    Decisions: state.decisions,
    Completion: state.completed,
    "Browser Log": evidence.browserLog,
    "Screenshot Text": evidence.screenshotText,
    Artifacts: {
      video: "video.webm",
      trace: "trace.zip",
      screenshots: "screenshots/",
      events: "events.json",
      actions: "actions.json",
    },
  });

const handleDecision = async (state: BridgeState, body: unknown) => {
  const request = decisionRequestSchema.parse(body);
  if (request.runId !== state.runId || request.sessionId !== state.sessionId) {
    throw new BridgeRequestError("Invalid run or session", 400);
  }
  const relativeScreenshotPath = path.relative(state.runDir, request.evidence.screenshotPath);
  if (relativeScreenshotPath.startsWith("..") || path.isAbsolute(relativeScreenshotPath)) {
    throw new BridgeRequestError("Screenshot path is outside the run directory", 400);
  }
  const hostScreenshotPath = path.join(state.hostRunDir, relativeScreenshotPath);
  const decision = await runPiJson({
    cwd: state.cwd,
    env: state.env,
    runDir: state.hostRunDir,
    kind: "decision",
    prompt: decisionPrompt(state.agent, request, state.events, state.decisions),
    schema: agentDecisionSchema,
    imagePaths: [hostScreenshotPath],
    command: state.piCommand,
    agent: state.agent,
    timeoutMs: state.agentTimeoutMs,
  });
  state.decisions.push(decision);
  await writeJson(path.join(state.hostRunDir, "actions.json"), state.decisions);

  return decision;
};

const handleComplete = async (state: BridgeState, body: unknown) => {
  const complete = runnerCompleteSchema.parse(body);
  if (complete.runId !== state.runId || complete.sessionId !== state.sessionId) {
    throw new BridgeRequestError("Invalid run or session", 400);
  }
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

      if (request.headers.authorization !== `Bearer ${state.authToken}`) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      try {
        const url = new URL(request.url ?? "/", "http://gameqa.local");
        const body = parseJson(await readStdin(request));

        if (url.pathname === "/sdk/events") {
          const batch = sdkEventBatchSchema.parse(body);
          if (batch.sessionId !== state.sessionId) {
            sendJson(response, 400, { error: "Invalid session" });
            return;
          }

          state.events.push(...batch.events);
          await writeJson(path.join(state.hostRunDir, "events.json"), state.events);
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
        sendJson(response, error instanceof BridgeRequestError ? error.status : 500, {
          error: error instanceof Error ? error.message : "Bridge request failed",
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
  const result = await runCommand(dockerCommand(env), runRunnerImageArgs({ image, runDir, job }), {
    cwd,
    env,
    timeoutMs: (job.timeoutSeconds + 60) * 1000,
  });

  if (result.code !== 0) {
    throw new Error(`GameQA browser runner failed: ${result.stderr || result.stdout}`);
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

const readOptionalFile = async (filePath: string) =>
  readFile(filePath, "utf8").catch(() => "(artifact not produced)");

const collectReportEvidence = async (runDir: string) => {
  const screenshotsDir = path.join(runDir, "screenshots");
  const names = await readdir(screenshotsDir).catch(() => []);
  const textNames = names
    .filter((name) => name.endsWith(".txt"))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .slice(-20);
  const screenshotText = Object.fromEntries(
    await Promise.all(
      textNames.map(async (name) => [
        `screenshots/${name}`,
        await readOptionalFile(path.join(screenshotsDir, name)),
      ]),
    ),
  );
  const imageNames = names
    .filter((name) => name.endsWith(".png"))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const selectedImages = [...new Set([imageNames[0], imageNames.at(-1)])]
    .filter((name): name is string => Boolean(name))
    .map((name) => path.join(screenshotsDir, name));

  const browserLog = await readOptionalFile(path.join(runDir, "browser.log"));
  return {
    browserLog: browserLog.slice(-50_000),
    screenshotText,
    selectedImages,
  };
};

const writeFinalReport = async (state: BridgeState) => {
  const evidence = await collectReportEvidence(state.hostRunDir);
  const report = await runPiJson({
    cwd: state.cwd,
    env: state.env,
    runDir: state.hostRunDir,
    kind: "report",
    prompt: reportPrompt(state, evidence),
    schema: reportSchema,
    imagePaths: evidence.selectedImages,
    command: state.piCommand,
    agent: state.agent,
    timeoutMs: state.agentTimeoutMs,
  });
  await writeJson(path.join(state.hostRunDir, "report.json"), report);
  await writeFile(path.join(state.hostRunDir, "report.md"), reportMarkdown(report), "utf8");
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
  const authToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const hostRunDir = path.resolve(cli.cwd, config.run.outputDir, runId);
  await mkdir(hostRunDir, { recursive: true });
  // The runner uses the non-root Playwright image user, whose UID can differ from the host user.
  await chmod(hostRunDir, 0o777);

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
    authToken,
    piCommand: cli.env.GAMEQA_PI_COMMAND ?? "pi",
    agentTimeoutMs: config.run.agentTimeoutSeconds * 1000,
    env: cli.env,
  };
  await writeRunSummary(state, options);
  const bridge = await createBridgeServer(state);

  try {
    const job = runnerJobSchema.parse({
      runId,
      sessionId,
      authToken,
      targetUrl: dockerReachableUrl(options.url),
      bridgeUrl: bridge.origin,
      maxTurns: config.run.maxTurns,
      timeoutSeconds: config.run.timeoutSeconds,
      settleMs: config.run.settleMs,
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

const printUsage = () => {
  print("GameQA - local agent-driven playtesting for instrumented web games");
  print();
  print("Usage:");
  print("  gameqa init");
  print("  gameqa run --agent <id> --url <url> [--config <path>]");
  print();
  print("Requires Docker and an authenticated Pi installation.");
};

export const runCli = async (cli: CliOptions) => {
  const { command, flags } = parseArgs(cli.argv);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    print(packageVersion);
    return;
  }

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
          typeof flags.get("config") === "string" ? (flags.get("config") as string) : undefined,
      },
      cli,
    );
    print(`GameQA run complete: ${path.relative(cli.cwd, result.runDir)}`);
    return;
  }

  throw new Error(`Unknown command: ${command}. Run gameqa --help for usage.`);
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
