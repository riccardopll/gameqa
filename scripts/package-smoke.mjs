import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, "artifacts");
const packageManifest = JSON.parse(
  await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
);
const version = packageManifest.version;
const fixture = await mkdtemp(path.join(tmpdir(), "gameqa-package-smoke-"));

try {
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });
  await exec("pnpm", ["--filter", "gameqa", "pack", "--pack-destination", artifacts], {
    cwd: root,
  });
  const tarball = path.join(artifacts, `gameqa-${version}.tgz`);
  await exec("npm", ["install", "--ignore-scripts", tarball], { cwd: fixture });

  const cli = path.join(fixture, "node_modules/.bin/gameqa");
  const versionOutput = await exec(cli, ["--version"], { cwd: fixture });
  if (versionOutput.stdout.trim() !== version) {
    throw new Error(`Unexpected CLI version: ${versionOutput.stdout}`);
  }

  await exec(cli, ["init"], { cwd: fixture });
  const config = await readFile(path.join(fixture, "gameqa.config.ts"), "utf8");
  if (!config.includes('adapter: "pi"')) throw new Error("Starter config does not use Pi");

  await exec(
    "node",
    [
      "--input-type=module",
      "--eval",
      'import("gameqa/sdk").then(({ client }) => { if (!client) process.exit(1); })',
    ],
    { cwd: fixture },
  );
  process.stdout.write(`Package smoke test passed: ${tarball}\n`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
