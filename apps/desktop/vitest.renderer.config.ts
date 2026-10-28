import path from "node:path";
import { automaticJsx, pinnedReporters } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";
import { resolveLaneConcurrency } from "./scripts/node-test-lane-settings.mjs";

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
// __tests__ directories only. No @vitejs/plugin-react needed — Vite's own oxc
// transform handles TSX with the automatic JSX runtime (same setup as
// packages/navigation).
export default defineConfig({
  // Belt-and-braces, not a requirement: oxc already defaults `jsx.runtime` to
  // `automatic`, and the nearest tsconfig.json (the main-process one) sets no
  // `jsx` to override it, so this config alone would transform correctly
  // without the pin. It stays because every other vitest config in the
  // workspace carries it and a lone omission reads as an oversight. The
  // predecessor `esbuild: { jsx: "automatic" }` genuinely was load-bearing —
  // esbuild defaults to the classic transform.
  oxc: automaticJsx(),
  resolve: {
    alias: {
      "@": path.resolve(here, "src/renderer"),
      "@repo/design-system": path.resolve(here, "../../packages/design-system"),
      "@closedloop-ai/design-system": path.resolve(
        here,
        "../../packages/design-system"
      ),
      // `@closedloop-ai/loops-api/*` exports now resolve to `src/` directly; this alias
      // is kept as an explicit source pin (mirrors the design-system alias
      // above) for renderer components that import loops-api directly (e.g.
      // first-launch-dashboard).
      "@repo/cost": path.resolve(here, "../../packages/cost/src"),
      "@repo/loops-api": path.resolve(here, "../../packages/loops-api/src"),
      "@closedloop-ai/loops-api": path.resolve(
        here,
        "../../packages/loops-api/src"
      ),
      "@repo/api": path.resolve(here, "../../packages/api"),
      "@repo/app": path.resolve(here, "../../packages/app"),
      // FEA-2717: `@repo/app`'s session-detail transcript panel deep-imports the
      // harness parser cores (`@repo/lib/harness/...`); resolve to source (same
      // as the renderer build config's `@repo/lib` alias).
      "@repo/lib": path.resolve(here, "../../packages/lib"),
      "@repo/analytics": path.resolve(here, "../../packages/analytics"),
      "@closedloop-ai/shared-platform/gateway-dispatch": path.join(
        sharedPlatformSrc,
        "gateway-dispatch.ts"
      ),
      "@repo/shared-platform/gateway-dispatch": path.join(
        sharedPlatformSrc,
        "gateway-dispatch.ts"
      ),
      "@closedloop-ai/shared-platform/gateway-fetch-shim": path.join(
        sharedPlatformSrc,
        "gateway-fetch-shim.ts"
      ),
      "@repo/shared-platform/gateway-fetch-shim": path.join(
        sharedPlatformSrc,
        "gateway-fetch-shim.ts"
      ),
      "@closedloop-ai/shared-platform/relay-request-model": path.join(
        sharedPlatformSrc,
        "relay-request-model.ts"
      ),
      "@repo/shared-platform/relay-request-model": path.join(
        sharedPlatformSrc,
        "relay-request-model.ts"
      ),
      "@closedloop-ai/shared-platform/routing-store": path.join(
        sharedPlatformSrc,
        "routing-store.ts"
      ),
      "@repo/shared-platform/routing-store": path.join(
        sharedPlatformSrc,
        "routing-store.ts"
      ),
      "@closedloop-ai/shared-platform/types": path.join(
        sharedPlatformSrc,
        "types.ts"
      ),
      "@repo/shared-platform/types": path.join(sharedPlatformSrc, "types.ts"),
    },
  },
  test: {
    reporters: pinnedReporters(),
    // globals also enables @testing-library/react auto-cleanup between tests.
    globals: true,
    environment: "jsdom",
    include: ["src/renderer/**/__tests__/**/*.test.{ts,tsx}"],
    // Anchored at THIS file's directory, never cwd (ISS-7952): a cwd-relative
    // setup path resolves against the repo root under Stryker, loads nothing,
    // and reports the whole related suite as `no tests`.
    setupFiles: [
      path.resolve(
        here,
        "src/renderer/__tests__/renderer-returning-install-setup.ts"
      ),
    ],
    // The SAME width the node lane runs at, from the same resolver — this lane
    // declared none, so it took Vitest's default of one worker per core while
    // its sibling capped at four. Every worker here builds a jsdom and mounts
    // the whole desktop shell, so an 8-wide run on an 8-core runner spends a
    // 15s `asyncUtilTimeout` (app-shell-harness.tsx, FEA-2023) on roughly 2s of
    // progress, and `findByRole` gives up on a heading that was always going to
    // arrive. Bounding the width is what makes that budget mean what it says;
    // raising it would only move the cliff (ISS-6732, ISS-9275).
    maxWorkers: resolveLaneConcurrency(),
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
