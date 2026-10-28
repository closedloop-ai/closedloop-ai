import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Anchored, not left to default to `process.cwd()`. Everything relative in
  // this file — `setupFiles`, the include/exclude globs, any output or cache
  // path — resolves
  // against `root`, and the aliases below already anchor to this directory, so
  // a run whose cwd is NOT this package resolved half the config against one
  // place and half against another. That is exactly what a repo-root Stryker
  // sandbox does (ISS-8174): Stryker spawns vitest at the sandbox root and
  // names this file with `--config`, so `./__tests__/setup.ts` resolved to
  // `<sandbox>/__tests__/setup.ts`, every collected suite died with
  // `Cannot find module`, and the mutation run reported `No tests were found`.
  // A no-op for every normal invocation, where cwd already is this package.
  root: import.meta.dirname,
  plugins: [react()],
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    environment: "node",
    globals: true, // Makes describe, it, expect available globally
    // Reset implementations as well as call history between tests. `clearMocks`
    // alone would leave `mockImplementation*` state behind for the next test.
    mockReset: true,
    // Anchored at this config's own directory because vitest resolves
    // `setupFiles` against `root`, which defaults to the CWD rather than to
    // this file. Every normal invocation runs from `apps/api` so the two agree
    // — but `pnpm mutation` spawns Stryker from the repo root (ISS-7952),
    // where the cwd-relative spelling resolved to `<repo>/__tests__/setup.ts`,
    // failed to load, and took all 35 related suites down as `no tests`.
    // Test-file discovery is already CWD-proof (vitest globs `include` and
    // `exclude` from `dir`). The sibling compatibility and integration configs
    // are anchored the same way — `apps/api` is a ROOT_SANDBOX_PACKAGES entry,
    // so any of its three lanes can be named with `--vitest-config` — and
    // `__tests__/setup.ts` anchors its own `.env.local` load for the same
    // reason, that one against the PROCESS cwd rather than against `root`.
    setupFiles: [path.resolve(import.meta.dirname, "./__tests__/setup.ts")],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "__tests__/compatibility/**",
      "__tests__/integration/**",
      // ISS-7168: the `.integration.test.ts` suffix marks a real-Postgres suite
      // wherever it lives, including co-located beside its source under `app/`
      // and `lib/`. Excluding only the `__tests__/integration/` DIRECTORY left
      // those co-located suites collected here, running against the unit job's
      // Postgres at Vitest's 5s default while the whole turbo fan-out competed
      // for the same database — a real regression in one of them was
      // indistinguishable from ambient timeout flake. The integration config
      // claims them by the same suffix, so each file lands in exactly one tier.
      "**/*.integration.test.ts",
    ],
    // Cache configuration for faster re-runs
    cache: {
      dir: "../../node_modules/.vitest", // Share cache at monorepo root
    },
    // Enable parallel execution
    pool: "threads",
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
      "@repo/loops-api": path.resolve(
        import.meta.dirname,
        "../../packages/loops-api/src"
      ),
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../../packages/loops-api/src"
      ),
      // Same shape as loops-api: source-consumed under `/src`, so its subpath
      // (`@repo/shared-platform/parse-env-ms`) must not fall to the catch-all,
      // which would drop the `/src` and fail to resolve.
      "@closedloop-ai/shared-platform": path.resolve(
        import.meta.dirname,
        "../../packages/shared-platform/src"
      ),
      "@repo/shared-platform": path.resolve(
        import.meta.dirname,
        "../../packages/shared-platform/src"
      ),
      "@repo/http-service": path.resolve(
        import.meta.dirname,
        "../../packages/http-service/src"
      ),
      "@repo/realtime-contract": path.resolve(
        import.meta.dirname,
        "../../packages/realtime-contract/src"
      ),
      "@repo/realtime-server": path.resolve(
        import.meta.dirname,
        "../../packages/realtime-server/src"
      ),
      "@repo/document-schema": path.resolve(
        import.meta.dirname,
        "../../packages/document-schema/src"
      ),
      "@repo": path.resolve(import.meta.dirname, "../../packages"),
      // `sync.ts` sits at the package root, not under `src/` (ISS-11426).
      "@closedloop-ai/telemetry-contract/sync": path.resolve(
        import.meta.dirname,
        "../../packages/telemetry-contract/sync.ts"
      ),
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
