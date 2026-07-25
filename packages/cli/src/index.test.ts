import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRunnerImageArgs,
  createBridgeServer,
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
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("parses commands and flags", () => {
    const parsed = parseArgs(["run", "--agent", "pi-qa", "--url", "http://localhost:5173"]);

    expect(parsed.command).toBe("run");
    expect(parsed.flags.get("agent")).toBe("pi-qa");
    expect(parsed.flags.get("url")).toBe("http://localhost:5173");
  });

  it("creates a starter config", async () => {
    const cwd = await makeTempDir();
    const configPath = await initConfig(cwd);
    const config = await loadConfig(cwd);

    expect(configPath.endsWith("gameqa.config.ts")).toBe(true);
    expect(config.agents[0]?.id).toBe("pi-qa");
  });

  it("loads config and selects one agent", async () => {
    const cwd = await makeTempDir();
    await writeFile(
      path.join(cwd, "gameqa.config.ts"),
      `export default {
              agents: [
                { id: "pi-qa", adapter: "pi", persona: "QA" }
              ]
            }`,
      "utf8",
    );

    const config = await loadConfig(cwd);
    const agent = selectAgent(config, "pi-qa");

    expect(agent.persona).toBe("QA");
    expect(() => selectAgent(config, "missing")).toThrow("Unknown GameQA agent");
  });

  it("authenticates bridge requests", async () => {
    const cwd = await makeTempDir();
    const state: Parameters<typeof createBridgeServer>[0] = {
      cwd,
      agent: { id: "pi-qa", adapter: "pi", persona: "QA" },
      runDir: "/gameqa-run",
      hostRunDir: cwd,
      runId: "run_test",
      sessionId: "session_test",
      events: [],
      decisions: [],
      completed: null,
      authToken: "a".repeat(64),
      piCommand: "pi",
      agentTimeoutMs: 1000,
      env: process.env,
    };
    const bridge = await createBridgeServer(state);

    try {
      const unauthorized = await fetch(`${bridge.localOrigin}/sdk/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      const wrongSession = await fetch(`${bridge.localOrigin}/sdk/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "wrong",
          events: [{ type: "log", name: "test", payload: {}, createdAt: new Date().toISOString() }],
        }),
      });
      expect(wrongSession.status).toBe(400);

      const oversized = await fetch(`${bridge.localOrigin}/sdk/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.authToken}`,
          "content-type": "application/json",
        },
        body: "x".repeat(1_000_001),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await bridge.close();
    }
  });

  it("maps local URLs to Docker host URLs", () => {
    expect(dockerReachableUrl("http://localhost:5173/game")).toBe(
      "http://host.docker.internal:5173/game",
    );
    expect(dockerReachableUrl("https://example.com/game")).toBe("https://example.com/game");
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
    expect(pullRunnerImageArgs("gameqa-runner:test")).toEqual(["pull", "gameqa-runner:test"]);
  });

  it("builds the Docker run command for one browser runner job", () => {
    const args = runRunnerImageArgs({
      image: "gameqa-runner:test",
      runDir: "/repo/.gameqa/runs/run_test",
      job: {
        runId: "run_test",
        sessionId: "session_test",
        authToken: "a".repeat(32),
        targetUrl: "http://host.docker.internal:5173",
        bridgeUrl: "http://host.docker.internal:3900",
        maxTurns: 5,
        timeoutSeconds: 60,
        settleMs: 0,
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
    await writeFile(path.join(cwd, "packages/browser-runner/Dockerfile"), "FROM scratch\n", "utf8");

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
