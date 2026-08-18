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
      // `@repo/cost` (ISS-4730) is the same shape — the token-cost engine lives
      // under `src/`, and the branch/transcript cost projectors import it as
      // `@repo/cost/genai-cost`, which the catch-all would resolve to a
      // nonexistent `packages/cost/genai-cost`.
      "@repo/cost": path.resolve(import.meta.dirname, "../cost/src"),
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../loops-api/src"
      ),
      "@closedloop-ai/design-system": path.resolve(
        import.meta.dirname,
        "../../packages/design-system"
      ),
      "@repo/shared-platform": path.resolve(
        import.meta.dirname,
        "../shared-platform/src"
      ),
      // @repo/crewd (FEA-3814) is source-consumed under a `/src` root too — its
      // `./model` subpath resolves to `src/model.ts` via package.json exports,
      // which the catch-all `@repo` alias below bypasses. Must precede `@repo`.
      "@repo/crewd": path.resolve(import.meta.dirname, "../crewd/src"),
      "@repo": path.resolve(import.meta.dirname, ".."),
    },
  },
});
