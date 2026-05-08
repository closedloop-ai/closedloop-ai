import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/artifacts.ts",
    "src/bootstrap-result.ts",
    "src/bundles.ts",
    "src/commands.ts",
    "src/common.ts",
    "src/context-pack.ts",
    "src/desktop-request.ts",
    "src/env-vars.ts",
    "src/error-codes.ts",
    "src/events.ts",
    "src/execution-result.ts",
    "src/multi-repo-policy.ts",
    "src/tokens.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
