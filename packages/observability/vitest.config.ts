import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@repo/cost": path.resolve(import.meta.dirname, "../cost/src"),
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../loops-api/src"
      ),
      "@closedloop-ai/telemetry-contract": path.resolve(
        import.meta.dirname,
        "../telemetry-contract/src"
      ),
    },
  },
});
