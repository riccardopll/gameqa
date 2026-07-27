import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakePi = path.join(repoRoot, "e2e/fixtures/fake-pi.ts");
const demoServers: ChildProcess[] = [];
const ports: Record<"cc" | "fps", number> = { cc: 0, fps: 0 };
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

const startDemoServer = async (packageName: string, port: number) => {
  const server = spawn(
    "pnpm",
    ["--filter", packageName, "dev", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, env: process.env, stdio: "pipe" },
  );
  demoServers.push(server);
  await waitForUrl(`http://127.0.0.1:${port}`);
};

beforeAll(async () => {
  [ports.cc, ports.fps] = await Promise.all([freePort(), freePort()]);
  fixtureDir = await mkdtemp(path.join(tmpdir(), "gameqa-e2e-"));
  await writeFile(
    path.join(fixtureDir, "gameqa.config.ts"),
    `export default {
      run: { outputDir: ".gameqa/runs", maxTurns: 5, timeoutSeconds: 120, agentTimeoutSeconds: 10, settleMs: 80 },
      agents: [{ id: "pi-qa", adapter: "pi", persona: "Verify each demo's core gameplay loop and report only observed defects." }],
    };\n`,
    "utf8",
  );

  await Promise.all([
    startDemoServer("@gameqa/demo-cc", ports.cc),
    startDemoServer("@gameqa/demo-fps", ports.fps),
  ]);
});

afterAll(async () => {
  for (const server of demoServers) server.kill("SIGTERM");
  await rm(fixtureDir, { recursive: true, force: true });
});

type RunArtifacts = {
  runDir: string;
  actions: Array<{ type: string; actionId?: string; scenario?: string }>;
  events: Array<{ name: string; payload: Record<string, unknown> }>;
  report: { summary: string; findings: Array<{ id: string }> };
  session: { status: string; stopReason: string };
  lastEvidence: string;
};

const runGame = async (port: number): Promise<RunArtifacts> => {
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

  const [actions, events, report, session] = await Promise.all([
    readFile(path.join(runDir, "actions.json"), "utf8").then(JSON.parse),
    readFile(path.join(runDir, "events.json"), "utf8").then(JSON.parse),
    readFile(path.join(runDir, "report.json"), "utf8").then(JSON.parse),
    readFile(path.join(runDir, "session.json"), "utf8").then(JSON.parse),
  ]);

  const evidenceNames = await readdir(path.join(runDir, "screenshots"));
  const textNames = evidenceNames
    .filter((name) => name.endsWith(".txt"))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  expect(evidenceNames.filter((name) => name.endsWith(".png")).length).toBeGreaterThanOrEqual(2);
  expect(textNames.length).toBeGreaterThanOrEqual(2);
  const lastEvidence = await readFile(path.join(runDir, "screenshots", textNames.at(-1)!), "utf8");
  await Promise.all([
    expect(stat(path.join(runDir, "video.webm"))).resolves.toBeDefined(),
    expect(stat(path.join(runDir, "trace.zip"))).resolves.toBeDefined(),
    expect(stat(path.join(runDir, "videos"))).rejects.toThrow(),
  ]);
  expect(session).toMatchObject({ status: "completed", stopReason: "agent_finish" });
  expect(report.findings).toEqual([]);

  return { runDir, actions, events, report, session, lastEvidence };
};

describe("GameQA demo games", () => {
  it("runs the clicker economy through an automatic-production purchase", async () => {
    const result = await runGame(ports.cc);

    expect(result.actions).toMatchObject([
      { type: "scenario", scenario: "seedBakery" },
      { type: "controller_action", actionId: "buy_oven" },
      { type: "finish" },
    ]);
    expect(result.events.map((event) => event.name)).toContain("bakery_seeded");
    expect(result.events.map((event) => event.name)).toContain("upgrade_purchased");
    const purchase = result.events.find((event) => event.name === "upgrade_purchased");
    expect(purchase?.payload).toMatchObject({ upgradeId: "oven", cost: 100, balance: 150 });
    expect(result.report.summary).toContain("valid economy");
    expect(result.lastEvidence).toContain("Crumb Foundry");
  });

  it("runs the real-time FPS through weapon switching and firing", async () => {
    const result = await runGame(ports.fps);

    expect(result.actions).toMatchObject([
      { type: "controller_action", actionId: "switch_rifle" },
      { type: "controller_action", actionId: "fire_weapon" },
      { type: "finish" },
    ]);
    expect(result.events.map((event) => event.name)).toContain("weapon_switched");
    expect(result.events.map((event) => event.name)).toContain("weapon_fired");
    const fired = result.events.find((event) => event.name === "weapon_fired");
    expect(fired?.payload).toMatchObject({ weapon: "rifle", ammo: 29, shotsFired: 1 });
    expect(result.report.summary).toContain("real-time arena");
    expect(result.lastEvidence).toContain("NEON RANGE");
    expect(result.lastEvidence).toContain("PULSE RIFLE");
  });
});
