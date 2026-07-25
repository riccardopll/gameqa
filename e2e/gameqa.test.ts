import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakePi = path.join(repoRoot, "e2e/fixtures/fake-pi.mjs");
let preview: ChildProcess | undefined;
let port = 0;
let fixtureDir = "";

const freePort = async () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate an E2E port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const waitForUrl = async (url: string) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

beforeAll(async () => {
  port = await freePort();
  fixtureDir = await mkdtemp(path.join(tmpdir(), "gameqa-e2e-"));
  await writeFile(
    path.join(fixtureDir, "gameqa.config.ts"),
    `export default {
      run: { outputDir: ".gameqa/runs", maxTurns: 4, timeoutSeconds: 120, agentTimeoutSeconds: 10, settleMs: 50 },
      agents: [{ id: "pi-qa", adapter: "pi", persona: "Reproduce economy invariants." }],
    };\n`,
    "utf8",
  );

  preview = spawn(
    "pnpm",
    ["--filter", "@gameqa/demo-game", "preview", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, env: process.env, stdio: "pipe" },
  );
  await waitForUrl(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  preview?.kill("SIGTERM");
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("GameQA full run", () => {
  it("finds the demo economy defect and writes complete evidence", async () => {
    const invocation = await execute(
      "node",
      [
        path.join(repoRoot, "packages/cli/dist/index.js"),
        "run",
        "--agent",
        "pi-qa",
        "--url",
        `http://127.0.0.1:${port}`,
      ],
      {
        cwd: fixtureDir,
        env: {
          ...process.env,
          GAMEQA_PI_COMMAND: fakePi,
          GAMEQA_RUNNER_IMAGE: process.env.GAMEQA_RUNNER_IMAGE ?? "gameqa-browser-runner:e2e",
        },
        timeout: 170_000,
      },
    );
    const relativeRunDir = invocation.stdout.match(/GameQA run complete: (.+)/)?.[1]?.trim();
    expect(relativeRunDir).toBeTruthy();
    const runDir = path.resolve(fixtureDir, relativeRunDir ?? "missing");

    const actions = JSON.parse(await readFile(path.join(runDir, "actions.json"), "utf8")) as Array<{
      type: string;
      actionId?: string;
    }>;
    const events = JSON.parse(await readFile(path.join(runDir, "events.json"), "utf8")) as Array<{
      name: string;
    }>;
    const report = JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8")) as {
      findings: Array<{ id: string }>;
    };
    const session = JSON.parse(await readFile(path.join(runDir, "session.json"), "utf8")) as {
      stopReason: string;
    };

    expect(actions).toMatchObject([
      { type: "controller_action", actionId: "buy_flask" },
      { type: "finish" },
    ]);
    expect(events.map((event) => event.name)).toContain("purchase_completed");
    expect(events.map((event) => event.name)).toContain("Economy invariant violated");
    expect(report.findings[0]?.id).toBe("negative-gold-purchase");
    expect(session.stopReason).toBe("agent_finish");
    await expect(stat(path.join(runDir, "screenshots/turn-1.png"))).resolves.toBeDefined();
    await expect(stat(path.join(runDir, "screenshots/turn-2.txt"))).resolves.toBeDefined();
    await expect(stat(path.join(runDir, "video.webm"))).resolves.toBeDefined();
    await expect(stat(path.join(runDir, "trace.zip"))).resolves.toBeDefined();
    await expect(stat(path.join(runDir, "videos"))).rejects.toThrow();
    expect(await readFile(path.join(runDir, "browser.log"), "utf8")).toContain(
      "Economy invariant violated",
    );
    expect(await readFile(path.join(runDir, "report.md"), "utf8")).toContain(
      "Unaffordable flask purchase",
    );
  });
});
