import path from "node:path";
import { defineConfig } from "vitest/config";

// Anchored to THIS FILE, never to `process.cwd()`. Under the normal
// `pnpm -C apps/desktop exec vitest` invocation the two are the same, but the
// mutation runner drives this config from a repo-root Stryker sandbox, where a
// cwd-relative `path.resolve` silently points outside the package and every
// alias resolves to a path that does not exist. Matches how
// `vitest.node.config.ts` already anchors its shim alias and setup file.
const here = import.meta.dirname;

// `@repo/shared-platform/*` now resolves to `src/` directly via its package
// exports; these explicit source aliases are kept as belt-and-suspenders and to
// mirror apps/app/vitest-shared-aliases.ts.
const sharedPlatformSrc = path.resolve(
  here,
  "../../packages/shared-platform/src"
);

// Renderer (React/jsdom) tests. Main-process tests stay on node:test via
// `tsx --test` (see the "test" script); this config covers the renderer
// __tests__ directories only. No @vitejs/plugin-react needed — vitest's
// esbuild handles TSX with the automatic JSX runtime (same setup as
// packages/navigation).
export default defineConfig({
  // The nearest tsconfig.json is the main-process one (no jsx setting), so
  // esbuild would fall back to the classic runtime; the renderer uses the
  // automatic runtime (tsconfig.renderer.json jsx: react-jsx).
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(here, "src/renderer"),
      "@closedloop-ai/design-system": path.resolve(here, "../../packages/design-system"),
      // `@closedloop-ai/loops-api/*` exports now resolve to `src/` directly; this alias
      // is kept as an explicit source pin (mirrors the design-system alias
      // above) for renderer components that import loops-api directly (e.g.
      // first-launch-dashboard).
      "@repo/cost": path.resolve(here, "../../packages/cost/src"),
      "@closedloop-ai/loops-api": path.resolve(here, "../../packages/loops-api/src"),
      "@repo/api": path.resolve(here, "../../packages/api"),
      "@repo/app": path.resolve(here, "../../packages/app"),
      // FEA-2717: `@repo/app`'s session-detail transcript panel deep-imports the
      // harness parser cores (`@repo/lib/harness/...`); resolve to source (same
      // as the renderer build config's `@repo/lib` alias).
      "@repo/lib": path.resolve(here, "../../packages/lib"),
      "@repo/shared-platform/gateway-dispatch": path.join(
        sharedPlatformSrc,
        "gateway-dispatch.ts"
      ),
      "@repo/shared-platform/gateway-fetch-shim": path.join(
        sharedPlatformSrc,
        "gateway-fetch-shim.ts"
      ),
      "@repo/shared-platform/relay-request-model": path.join(
        sharedPlatformSrc,
        "relay-request-model.ts"
      ),
      "@repo/shared-platform/routing-store": path.join(
        sharedPlatformSrc,
        "routing-store.ts"
      ),
      "@repo/shared-platform/types": path.join(sharedPlatformSrc, "types.ts"),
    },
  },
  test: {
    // globals also enables @testing-library/react auto-cleanup between tests.
    globals: true,
    environment: "jsdom",
    include: ["src/renderer/**/__tests__/**/*.test.{ts,tsx}"],
    // Opt-in via `vitest run --coverage` (test:renderer:coverage, ISS-4594).
    // `include` makes this an all-files universe: a renderer source file no
    // test ever imports still counts as uncovered instead of vanishing from
    // the denominator. Extension-qualified on purpose — a bare `src/renderer/**`
    // feeds non-code files (design-system/index.html) into the uncovered-files
    // transform, which crashes the provider's Rollup parse.
    coverage: {
      enabled: false,
      provider: "v8",
      include: ["src/renderer/**/*.{ts,tsx}"],
      exclude: [
        "src/renderer/**/__tests__/**",
        "src/renderer/**/*.test.{ts,tsx}",
      ],
      reporter: ["json", "json-summary"],
      reportsDirectory: "coverage/renderer",
      // Measurement lane, not a gate: a run with a failing test must still
      // report what executed (vitest defaults this to false and silently
      // writes nothing on failure). Lane exit codes carry the failure signal.
      reportOnFailure: true,
    },
  },
});
