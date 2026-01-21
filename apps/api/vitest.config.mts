import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true, // Makes describe, it, expect available globally
    setupFiles: ["./__tests__/setup.ts"],
    // Cache configuration for faster re-runs
    cache: {
      dir: "../../node_modules/.vitest", // Share cache at monorepo root
    },
    // Enable parallel execution
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      "@repo": path.resolve(__dirname, "../../packages"),
      // Mock server-only package to prevent errors in tests
      "server-only": path.resolve(__dirname, "./__tests__/utils/server-only-mock.ts"),
    },
  },
});
