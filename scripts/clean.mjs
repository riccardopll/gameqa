import { rm } from "node:fs/promises";
import { glob } from "node:fs/promises";

const paths = ["coverage", "playwright-report", "test-results", "artifacts"];
for await (const entry of glob("packages/*/dist")) paths.push(entry);
for (const entry of paths) await rm(entry, { recursive: true, force: true });
