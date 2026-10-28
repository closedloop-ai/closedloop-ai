import path from "node:path";
import {
  automaticJsx,
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import {
  defineConfig,
  type TestProjectInlineConfiguration,
} from "vitest/config";
import { storybookModuleAliases } from "./.storybook/module-aliases";
import { STORYBOOK_BROWSER_EXCLUSIONS } from "./storybook-browser-exclusions";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * ISS-10397 — the browser-mode `storybookTest` project behind addon-mcp's
 * `test-run` tool (and the Testing widget in the Storybook UI).
 *
 * It is OPT-IN, and only these two callers opt in:
 *   - `@storybook/addon-vitest`, which starts its own Vitest child from
 *     `storybook dev` with `VITEST_STORYBOOK=true` and selects the project by
 *     its `storybook:<configDir>` name. That child is what `test-run` drives.
 *   - `pnpm test:storybook` (`STORYBOOK_BROWSER_TESTS=1`), the nightly
 *     Storybook Browser workflow's lane.
 *
 * Every other caller — `pnpm test`, `test:coverage`, the bulk `turbo` lane,
 * the config-importing lint guards — resolves the jsdom config below exactly
 * as before. Adding the project unconditionally would put a Playwright browser
 * into each of them; its cost is why this lane is nightly, not on the PR gate.
 *
 * The opted-in config is a separate root, not a second project beside the
 * jsdom one: Vitest hands a root's `test` options (here the jsdom setup file,
 * whose `node:timers` import cannot load in a browser) to its inline projects,
 * and the root's PostCSS-off override would strip the CSS a browser can
 * actually check. The plugin builds the project's Vite config from
 * `.storybook/main.ts` itself (its `viteFinal` aliases and the preview
 * annotations), so the browser renders a story the way `storybook dev` does.
 */
const STORYBOOK_BROWSER_LANE =
  process.env.VITEST_STORYBOOK === "true" ||
  process.env.STORYBOOK_BROWSER_TESTS === "1";

/**
 * A function, not a value: `storybookTest()` starts loading the Storybook
 * presets and applying `viteFinal` the moment it is called, and nothing awaits
 * that promise on the jsdom branch. Building the project only when the lane is
 * opted in keeps `pnpm test` and the config-importing lint guards from
 * bootstrapping Storybook at all (and a bootstrap failure from surfacing there
 * as an unhandled rejection).
 */
const storybookBrowserProject = (): TestProjectInlineConfiguration => ({
  plugins: [
    storybookTest({
      configDir: path.join(import.meta.dirname, ".storybook"),
    }),
  ],
  test: {
    exclude: [...STORYBOOK_BROWSER_EXCLUSIONS],
    setupFiles: ["./vitest.browser-setup.ts"],
    // No retry. The one it used to have covered a `toBeVisible()` racing an
    // enter animation, and `vitest.browser-setup.ts` now removes the animation
    // (the full run passes without a retry). A retry left in place would hide
    // the next timing failure, whatever its cause. A story that fails here is a
    // real failure or belongs in the exclusion list with ISS-12836.
    browser: {
      enabled: true,
      // addon-vitest refuses to start a headed run with more than one project.
      headless: true,
      provider: playwright(),
      // Vitest's browser default is a 414x896 phone, where the app shell
      // collapses its sidebar and toolbars and every story that queries them
      // fails (73 of 574 files on the first ISS-10397 run). Playwright's own
      // desktop default instead, the size `storybook dev` stories are written
      // against.
      viewport: { width: 1280, height: 720 },
      instances: [{ browser: "chromium" }],
    },
  },
});

const storybookBrowserConfig = () =>
  defineConfig({
    test: {
      reporters: pinnedReporters(),
      projects: [storybookBrowserProject()],
    },
  });

const jsdomConfig = defineConfig({
  oxc: automaticJsx(),
  // `.storybook/preview.tsx` imports two stylesheets. jsdom does no layout, so
  // nothing here can assert on styling and running PostCSS would be pure cost
  // — this app's `postcss.config.mjs` now re-exports the design-system config
  // (`@tailwindcss/postcss`), same as every sibling app, so there is no
  // failure left to avoid here either; this override is a pure cost-avoidance
  // choice, not a workaround. (It used to be both: `postcss.config.mjs`
  // registered `tailwindcss` directly, which Tailwind v4 rejects, and the
  // Storybook builder was webpack-based and never exercised that path — the
  // ISS-10257 Vite migration fixed the config itself rather than leaving this
  // override to carry the whole weight.)
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      // The shared map (also used by `.storybook/main.ts`'s Vite resolver)
      // carries the deep subpath aliases — `@closedloop-ai/telemetry-contract/*`
      // and `@repo/shared-platform/*` — that stories reach transitively, plus
      // `@repo/cost` and the `@repo` catch-all. The desktop
      // renderer's session-detail-view story is the proof: it pulls in
      // `@closedloop-ai/telemetry-contract/attributes` and fails to resolve
      // without them. Its own declaration order is the ordering contract that
      // module documents, and the one `packages/app/vitest.config.ts` restates.
      ...storybookModuleAliases(repoRoot),
      // `@repo/analytics/client`'s top-level `import ... from "@posthog/next"`
      // (Surfaces/PRDs, Surfaces/Implementation Plans — both editor headers
      // read a PostHog-gated flag) fails to resolve under Vitest/jsdom: the
      // installed package's `index.client.js` re-exports `./client/
      // PostHogPageView` without a Node-resolvable extension, which esbuild's
      // dep scan cannot follow here even though the file exists on disk. No
      // prior story imported this package, so nothing hit it before tonight.
      // `apps/app/vitest.config.mts` already solved the identical problem for
      // its own suite with this exact alias; reused rather than duplicated so
      // the two mocks cannot drift. Safe: `useFeatureFlag` (`packages/
      // analytics/client.ts`) only calls into the real `@posthog/next` hook
      // this mock replaces when `NEXT_PUBLIC_POSTHOG_KEY` is set, which it
      // never is under this harness — every story here already resolves flags
      // through the closed-by-default fallback path instead.
      "@posthog/next": path.resolve(
        repoRoot,
        "apps/app/vitest-mocks/posthog-next.tsx"
      ),
    },
  },
});

export default STORYBOOK_BROWSER_LANE ? storybookBrowserConfig() : jsdomConfig;
