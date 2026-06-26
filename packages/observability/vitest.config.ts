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
