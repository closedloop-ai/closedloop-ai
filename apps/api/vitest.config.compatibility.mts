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
      "@repo": path.resolve(import.meta.dirname, "../../packages"),
      // Mock server-only package to prevent errors in tests
      "server-only": path.resolve(
        import.meta.dirname,
        "./__tests__/utils/server-only-mock.ts"
      ),
    },
  },
});
