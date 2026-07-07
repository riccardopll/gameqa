import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    buildRunnerImageArgs,
    buildCodexArgs,
    dockerReachableUrl,
    ensureRunnerImage,
    initConfig,
    loadConfig,
    parseArgs,
    pullRunnerImageArgs,
    runRunnerImageArgs,
    selectAgent,
} from "./index";

const tempDirs: string[] = [];

const makeTempDir = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gameqa-cli-"));
    tempDirs.push(dir);
    return dir;
};

describe("gameqa cli", () => {
    afterEach(async () => {
        await Promise.all(
            tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
        );
    });

    it("parses commands and flags", () => {
        const parsed = parseArgs([
            "run",
            "--agent",
            "codex-qa",
            "--url",
            "http://localhost:5173",
        ]);

        expect(parsed.command).toBe("run");
        expect(parsed.flags.get("agent")).toBe("codex-qa");
        expect(parsed.flags.get("url")).toBe("http://localhost:5173");
    });

    it("creates a starter config", async () => {
        const cwd = await makeTempDir();
        const configPath = await initConfig(cwd);
        const config = await loadConfig(cwd);

        expect(configPath.endsWith("gameqa.config.ts")).toBe(true);
        expect(config.agents[0]?.id).toBe("codex-qa");
    });

    it("loads config and selects one agent", async () => {
        const cwd = await makeTempDir();
        await writeFile(
            path.join(cwd, "gameqa.config.ts"),
            `export default {
              agents: [
                { id: "codex-qa", adapter: "codex", persona: "QA" }
              ]
            }`,
            "utf8",
        );

        const config = await loadConfig(cwd);
        const agent = selectAgent(config, "codex-qa");

        expect(agent.persona).toBe("QA");
        expect(() => selectAgent(config, "missing")).toThrow("Unknown GameQA agent");
    });

    it("maps local URLs to Docker host URLs", () => {
        expect(dockerReachableUrl("http://localhost:5173/game")).toBe(
            "http://host.docker.internal:5173/game",
        );
        expect(dockerReachableUrl("https://example.com/game")).toBe(
            "https://example.com/game",
        );
    });

    it("builds a read-only Codex exec command", () => {
        const args = buildCodexArgs({
            cwd: "/repo",
            schemaPath: "/run/schema.json",
            outputPath: "/run/out.json",
            promptPath: "/run/prompt.md",
            imagePath: "/run/screenshot.png",
        });

        expect(args).toContain("exec");
        expect(args).toContain("--sandbox");
        expect(args).toContain("read-only");
        expect(args).toContain("--output-schema");
        expect(args).toContain("/run/schema.json");
        expect(args).toContain("--image");
        expect(args).toContain("/run/screenshot.png");
        expect(args.at(-1)).toBe("-");
    });

    it("builds runner image setup commands", () => {
        expect(
            buildRunnerImageArgs({
                image: "gameqa-runner:test",
                dockerfile: "/repo/packages/browser-runner/Dockerfile",
                context: "/repo",
            }),
        ).toEqual([
            "build",
            "-f",
            "/repo/packages/browser-runner/Dockerfile",
            "-t",
            "gameqa-runner:test",
            "/repo",
        ]);
        expect(pullRunnerImageArgs("gameqa-runner:test")).toEqual([
            "pull",
            "gameqa-runner:test",
        ]);
    });

    it("builds the Docker run command for one browser runner job", () => {
        const args = runRunnerImageArgs({
            image: "gameqa-runner:test",
            runDir: "/repo/.gameqa/runs/run_test",
            job: {
                runId: "run_test",
                sessionId: "session_test",
                targetUrl: "http://host.docker.internal:5173",
                bridgeUrl: "http://host.docker.internal:3900",
                maxTurns: 5,
                timeoutSeconds: 60,
                workDir: "/gameqa-run",
            },
        });

        expect(args.slice(0, 8)).toEqual([
            "run",
            "--rm",
            "--add-host",
            "host.docker.internal:host-gateway",
            "-v",
            "/repo/.gameqa/runs/run_test:/gameqa-run",
            "-e",
            args[7],
        ]);
        expect(args.at(-1)).toBe("gameqa-runner:test");
    });

    it("builds a missing runner image from a local Dockerfile before pulling", async () => {
        const cwd = await makeTempDir();
        const logPath = path.join(cwd, "docker.log");
        const fakeDocker = path.join(cwd, "docker");
        await writeFile(
            fakeDocker,
            `#!/bin/sh
echo "$@" >> "${logPath}"
if [ "$1" = "image" ]; then exit 1; fi
exit 0
`,
            "utf8",
        );
        await chmod(fakeDocker, 0o755);
        await mkdir(path.join(cwd, "packages/browser-runner"), { recursive: true });
        await writeFile(
            path.join(cwd, "packages/browser-runner/Dockerfile"),
            "FROM scratch\n",
            "utf8",
        );

        const image = await ensureRunnerImage(cwd, {
            GAMEQA_DOCKER_COMMAND: fakeDocker,
            GAMEQA_RUNNER_IMAGE: "gameqa-runner:test",
        });
        const log = await readFile(logPath, "utf8");

        expect(image).toBe("gameqa-runner:test");
        expect(log).toContain("image inspect gameqa-runner:test");
        expect(log).toContain("build -f");
        expect(log).not.toContain("pull gameqa-runner:test");
    });

    it("pulls a missing runner image when no local Dockerfile exists", async () => {
        const cwd = await makeTempDir();
        const logPath = path.join(cwd, "docker.log");
        const fakeDocker = path.join(cwd, "docker");
        await writeFile(
            fakeDocker,
            `#!/bin/sh
echo "$@" >> "${logPath}"
if [ "$1" = "image" ]; then exit 1; fi
exit 0
`,
            "utf8",
        );
        await chmod(fakeDocker, 0o755);

        const image = await ensureRunnerImage(cwd, {
            GAMEQA_DOCKER_COMMAND: fakeDocker,
            GAMEQA_RUNNER_IMAGE: "gameqa-runner:test",
        });
        const log = await readFile(logPath, "utf8");

        expect(image).toBe("gameqa-runner:test");
        expect(log).toContain("image inspect gameqa-runner:test");
        expect(log).toContain("pull gameqa-runner:test");
        expect(log).not.toContain("build -f");
    });
});
