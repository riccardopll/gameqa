import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentDecisionSchema, type Config } from "@gameqa/shared";
import { buildPiArgs, parsePiJson, runPiJson } from "./pi-adapter";
import { runCommand } from "./process";

const tempDirs: string[] = [];
const agent: Config["agents"][number] = {
  id: "pi-qa",
  adapter: "pi",
  persona: "Find bugs.",
  provider: "openai",
  model: "gpt-test",
  thinking: "low",
};

const makeTempDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gameqa-pi-"));
  tempDirs.push(dir);
  return dir;
};

describe("Pi adapter", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds an isolated non-interactive Pi command", () => {
    const args = buildPiArgs(agent, ["/run/turn-1.png"]);

    expect(args).toContain("--print");
    expect(args).toContain("--no-session");
    expect(args).toContain("--no-tools");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--provider");
    expect(args).toContain("openai");
    expect(args).toContain("@/run/turn-1.png");
  });

  it("parses plain and fenced JSON responses", () => {
    expect(parsePiJson('{"type":"finish","reason":"done"}')).toMatchObject({ type: "finish" });
    expect(parsePiJson('Result:\n```json\n{"type":"finish","reason":"done"}\n```')).toMatchObject({
      type: "finish",
    });
  });

  it("pipes prompts over stdin and validates Pi output", async () => {
    const cwd = await makeTempDir();
    const command = path.join(cwd, "fake-pi");
    const capturedPrompt = path.join(cwd, "stdin.txt");
    await writeFile(
      command,
      `#!/bin/sh\ncat > "${capturedPrompt}"\nprintf '%s\\n' '{"type":"finish","reason":"Enough evidence"}'\n`,
      "utf8",
    );
    await chmod(command, 0o755);

    const result = await runPiJson({
      cwd,
      env: process.env,
      runDir: cwd,
      kind: "decision",
      prompt: "Choose an action.",
      schema: agentDecisionSchema,
      command,
      agent,
      timeoutMs: 2000,
    });

    expect(result).toEqual({ type: "finish", reason: "Enough evidence" });
    expect(await readFile(capturedPrompt, "utf8")).toContain("Required JSON Schema");
  });

  it("reports missing commands and timeouts", async () => {
    const cwd = await makeTempDir();
    await expect(runCommand(path.join(cwd, "missing"), [], { cwd })).rejects.toThrow(
      "Unable to start",
    );

    const command = path.join(cwd, "slow");
    await writeFile(command, "#!/bin/sh\nexec sleep 2\n", "utf8");
    await chmod(command, 0o755);
    await expect(runCommand(command, [], { cwd, timeoutMs: 10 })).rejects.toThrow("timed out");
  });
});
