import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost",
      },
    },
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      // Resolve workspace packages from source. `@closedloop-ai/loops-api` and
      // `@repo/shared-platform` are source-consumed under a `/src` root, so
      // their specific aliases MUST precede the catch-all `@repo` (Vite matches
      // aliases in declaration order). `@repo/api`'s type modules re-export from
      // both, so these are reachable transitively even without a direct import.
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../loops-api/src"
      ),
      "@repo/shared-platform": path.resolve(
        import.meta.dirname,
        "../shared-platform/src"
      ),
      "@repo": path.resolve(import.meta.dirname, ".."),
    },
  },
});
