import path from "node:path";
import { unhandledErrorReporter } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

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
    environment: "node",
    globals: true,
    // Anchored at this config's own directory, not cwd-relative: vitest
    // resolves `setupFiles` against `root`, which is the repo root under
    // `pnpm mutation` (ISS-7952). See vitest.config.mts for the full note —
    // `apps/api` is a ROOT_SANDBOX_PACKAGES entry, so EVERY lane of it can be
    // named with `--vitest-config` and must survive a repo-root `root`.
    setupFiles: [path.resolve(import.meta.dirname, "./__tests__/setup.ts")],
    include: [
      "__tests__/compatibility/**/*.test.ts",
      "__tests__/health.test.ts",
    ],
    testTimeout: 15_000,
    // The list stays hardcoded rather than becoming `pinnedReporters()`: this
    // lane's `json`/`outputFile` pair is the reason it pinned reporters before
    // ISS-6947, and it has never carried `github-actions`. Appending the shared
    // unhandled-error reporter is the part that was missing — without it this
    // was the ONE lane in the repo that could still exit 1 with `Tests N passed`
    // and no attribution of the file the error came from (whitlockk review).
    reporters: ["default", "json", unhandledErrorReporter],
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
