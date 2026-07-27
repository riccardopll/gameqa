import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const workspacePackage = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@gameqa/sdk": workspacePackage("../sdk/src/index.ts"),
      "@gameqa/shared": workspacePackage("../shared/src/index.ts"),
    },
  },
  preview: {
    allowedHosts: true,
  },
  server: {
    allowedHosts: true,
  },
});
