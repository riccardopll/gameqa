import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "gameqa/shared": resolvePath("./packages/shared/src/index.ts"),
      "gameqa/sdk": resolvePath("./packages/sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
