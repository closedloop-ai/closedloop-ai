import path from "node:path";
import { defineConfig } from "vitest/config";

// Dedicated config for the apps/api integration suites (run via
// `pnpm --filter=api test:integration`, gated on DATABASE_URL in CI).
//
// Self-contained (mirrors vitest.config.compatibility.mts) rather than merged
// onto the base config: mergeConfig concatenates arrays, so inheriting a future
// `test.exclude` from the base — which currently excludes
// `__tests__/integration/**` — would silently drop this run's whole scope.
// Owning the full config keeps the integration scope explicit and decoupled
// from the default `test` config.
//
// These suites hit a real Postgres via `withDb` (each suite self-skips when
// DATABASE_URL is unset), which exceeds Vitest's 5s default under CI/parallel
// load, so budget the whole run generously here (matching the @repo/database
// integration tier) instead of a per-test timeout in every suite.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./__tests__/setup.ts"],
    include: ["__tests__/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./"),
      // The specific loops-api alias MUST precede the catch-all `@repo`: its
      // subpaths resolve to `packages/loops-api/src/*` (source-consumed, no
      // dist), whereas the generic `@repo` → `packages` mapping would drop the
      // `/src` and fail to resolve. Vite matches aliases in declaration order.
      "@repo/cost": path.resolve(
        import.meta.dirname,
        "../../packages/cost/src"
      ),
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
