import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./__tests__/setup.ts"],
    include: [
      "__tests__/compatibility/**/*.test.ts",
      "__tests__/health.test.ts",
    ],
    testTimeout: 15_000,
    reporters: ["default", "json"],
    outputFile: {
      json: "compatibility-results.json",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./"),
      // The specific loops-api alias MUST precede the catch-all `@repo`: its
      // subpaths resolve to `packages/loops-api/src/*` (source-consumed, no
      // dist), whereas the generic `@repo` → `packages` mapping would drop the
      // `/src` and fail to resolve. Vite matches aliases in declaration order.
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../../packages/loops-api/src"
      ),
      "@repo": path.resolve(import.meta.dirname, "../../packages"),
      "@closedloop-ai/telemetry-contract": path.resolve(
        import.meta.dirname,
        "../../packages/telemetry-contract/src"
      ),
      // Mock server-only package to prevent errors in tests
      "server-only": path.resolve(
        import.meta.dirname,
        "./__tests__/utils/server-only-mock.ts"
      ),
    },
  },
});
