import { defineConfig } from "tsdown";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        sdk: "../sdk/src/index.ts",
    },
    format: "esm",
    target: "es2022",
    dts: {
        resolver: "tsc",
    },
    fixedExtension: false,
    deps: {
        alwaysBundle: ["gameqa/shared", "zod"],
        onlyBundle: ["zod"],
        dts: {
            neverBundle: ["zod"],
        },
    },
});
