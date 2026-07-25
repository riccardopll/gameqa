import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toJSONSchema, type ZodType } from "zod";
import type { Config } from "@gameqa/shared";
import { runCommand } from "./process";

export type PiAgent = Config["agents"][number];

export const buildPiArgs = (agent: PiAgent, imagePaths: string[] = []) => [
  "--print",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-approve",
  "--system-prompt",
  "You are a game QA decision engine. Return only the requested JSON object without Markdown fences or commentary.",
  ...(agent.provider ? ["--provider", agent.provider] : []),
  ...(agent.model ? ["--model", agent.model] : []),
  ...(agent.thinking ? ["--thinking", agent.thinking] : []),
  ...imagePaths.map((imagePath) => `@${imagePath}`),
];

export const parsePiJson = (output: string): unknown => {
  const trimmed = output.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next representation.
    }
  }

  throw new Error(`Pi did not return a JSON object: ${trimmed.slice(0, 500)}`);
};

export const runPiJson = async <T>(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  runDir: string;
  kind: "decision" | "report";
  prompt: string;
  schema: ZodType<T>;
  imagePaths?: string[];
  command: string;
  agent: PiAgent;
  timeoutMs: number;
}) => {
  const dir = path.join(input.runDir, "pi", `${input.kind}s`);
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const promptPath = path.join(dir, `${timestamp}.md`);
  const responsePath = path.join(dir, `${timestamp}.response.txt`);
  const schema = toJSONSchema(input.schema);
  const prompt = `${input.prompt}\n\n## Required JSON Schema\n${JSON.stringify(schema, null, 2)}\n\nReturn exactly one JSON object that validates against this schema.`;
  await writeFile(promptPath, prompt, "utf8");

  const result = await runCommand(input.command, buildPiArgs(input.agent, input.imagePaths), {
    cwd: input.cwd,
    env: input.env,
    input: prompt,
    timeoutMs: input.timeoutMs,
  });
  await writeFile(responsePath, result.stdout, "utf8");

  if (result.code !== 0) {
    throw new Error(`Pi ${input.kind} failed: ${result.stderr || result.stdout}`);
  }

  return input.schema.parse(parsePiJson(result.stdout));
};
