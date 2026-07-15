import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true, // Makes describe, it, expect available globally
    setupFiles: ["./__tests__/setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "__tests__/compatibility/**",
      "__tests__/integration/**",
    ],
    // Cache configuration for faster re-runs
    cache: {
      dir: "../../node_modules/.vitest", // Share cache at monorepo root
    },
    // Enable parallel execution
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: false,
      },
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
