import path from "node:path";
import { pinnedReporters } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

// ISS-8967. The GitHub Actions lane's executed-count verdict reads its tallies
// from the json reporter rather than scraping stdout, because capturing stdout
// there would mean piping the lane's verdict command — which
// scripts/deploy/dagger-guard-lane-parity-source.test.ts pins byte-for-byte
// against the Dagger lane. Off unless the lane asks for it, so a local run, the
// Dagger tier and `pnpm test:affected` are all unchanged.
const jsonSummaryPath = process.env.API_INTEGRATION_JSON_SUMMARY;

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
  test: {
    // `json` is APPENDED to the pin, never a replacement for it: the pinned list
    // is what keeps vitest from auto-selecting the silent `agent` reporter
    // (ISS-6947) and what carries the `github-actions` annotations.
    reporters: jsonSummaryPath
      ? [...pinnedReporters(), "json"]
      : pinnedReporters(),
    ...(jsonSummaryPath ? { outputFile: { json: jsonSummaryPath } } : {}),
    environment: "node",
    globals: true,
    // Anchored at this config's own directory, not cwd-relative: vitest
    // resolves `setupFiles` against `root`, which is the repo root under
    // `pnpm mutation` (ISS-7952). See vitest.config.mts for the full note —
    // `apps/api` is a ROOT_SANDBOX_PACKAGES entry, so EVERY lane of it can be
    // named with `--vitest-config` and must survive a repo-root `root`.
    setupFiles: [path.resolve(import.meta.dirname, "./__tests__/setup.ts")],
    // Two shapes of the same tier. The directory glob claims the suites that
    // live under `__tests__/integration/` regardless of filename; the suffix
    // glob (ISS-7168) claims the DB-backed suites co-located beside their
    // source under `app/`/`lib/`, which the base unit config now excludes by
    // the same suffix. Vitest unions and de-duplicates the include globs, so
    // the files matching both are collected once.
    include: ["__tests__/integration/**/*.test.ts", "**/*.integration.test.ts"],
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
