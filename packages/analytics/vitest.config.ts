import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  automaticJsx,
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

/**
 * The posthog-js copy PRODUCTION initializes.
 *
 * `@posthog/next` pins `posthog-js` exactly and its `ClientPostHogProvider` —
 * the module that calls `posthog.init` in the browser — imports it from its own
 * nested resolution. This package declares a newer `posthog-js` of its own, so
 * a bare `import "posthog-js"` in a test loads a client the app never runs
 * (whitlockk review on ISS-8295). Resolving through `@posthog/next` follows whatever
 * that dependency pins, including after a bump, rather than pinning a version
 * literal here that would go stale silently. Exact-match so a subpath import is
 * left alone.
 */
const SHIPPED_POSTHOG_JS = createRequire(
  createRequire(import.meta.url).resolve("@posthog/next")
).resolve("posthog-js");

/**
 * The React bindings of that SAME copy. Without this the exact-match alias
 * above leaves `posthog-js/react` resolving to this package's own newer
 * posthog-js, so a suite and the `ClientPostHogProvider` it renders hold two
 * different React contexts and `usePostHog()` silently returns the default
 * instead of the client just initialized — the subpath form of the same trap.
 */
const SHIPPED_POSTHOG_JS_REACT = join(dirname(SHIPPED_POSTHOG_JS), "../react");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^posthog-js$/, replacement: SHIPPED_POSTHOG_JS },
      {
        find: /^posthog-js\/react$/,
        replacement: SHIPPED_POSTHOG_JS_REACT,
      },
    ],
  },
  oxc: automaticJsx(),
  test: {
    // `ClientPostHogProvider` is ESM importing `posthog-js/react`, a subpath
    // with a `main` but no `exports` — resolvable by Vite, a hard
    // `ERR_UNSUPPORTED_DIR_IMPORT` for Node's own ESM loader. Externalized (the
    // default for a node_modules dependency) the module cannot be loaded at
    // all, so the one suite that renders the real provider needs it processed.
    server: { deps: { inline: [/@posthog[\\/]next/] } },
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    globals: true,
    environment: "jsdom",
    setupFiles: ["../typescript-config/vitest-localstorage-setup"],
    // Rooted at this package, so the glob can only ever match this package's own
    // tests — the same reason packages/design-system spells its include out
    // rather than inheriting vitest's default relative to wherever the config
    // resolves from.
    //
    // Vitest's OWN default pattern, spelled out rather than narrowed: a glob that
    // accepted only `.test.{ts,tsx}` would silently drop a future `.spec.ts`, and
    // a suite excluded at collection is invisible to `passWithNoTests: false`
    // below — the remaining suites keep the lane green, which is the same vacuous
    // green this ticket exists to remove, one file at a time instead of all nine.
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // ISS-8144: an empty run must FAIL. This package ran nine suites behind
    // `--passWithNoTests`, so a broken glob, a moved directory or a renamed
    // config would have exited 0 having executed none of them. Explicit rather
    // than inherited — vitest's default is already `false`, but the failing
    // behavior is the point of the lane and must not be one CLI flag away from
    // being switched off silently.
    passWithNoTests: false,
  },
});
