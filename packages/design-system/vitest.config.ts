import path from "node:path";
import {
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    globals: true,
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost",
      },
    },
    setupFiles: ["./vitest.setup.ts"],
    // Rooted at this package, so the glob can only ever match this package's own
    // tests. A config that leaves `include` at vitest's default inherits the
    // default glob relative to wherever the config is resolved from — the shape
    // that lets a lane report success over four unrelated files.
    include: ["**/*.test.{ts,tsx}"],
    // ISS-6631: an empty run must FAIL, not pass. This package's whole reason for
    // having a runner is that its components had nowhere to land a regression
    // test; a lane that exits 0 having collected zero files reinstates exactly
    // that hole, and — because `test:coverage` shares this config — hands the
    // aggregator an empty map, which `readPackageMap` classifies as `corrupt`
    // and reports as "not measured". Explicit rather than inherited: vitest's
    // default is already `false`, but the failing behavior is the point of the
    // lane and must not be one CLI flag away from being switched off silently.
    passWithNoTests: false,
  },
  resolve: {
    alias: {
      // The ONLY alias this package needs, and deliberately not the catch-all
      // `@repo` that packages/app declares. This package imports itself by its
      // published specifier (`@closedloop-ai/design-system/lib/utils`,
      // `@closedloop-ai/design-system/hooks/…`) and pnpm creates no self-link, because it
      // does not depend on itself — so without this every component module fails
      // to resolve. Every OTHER `@repo/*` it imports (only `@repo/navigation`)
      // has a real pnpm symlink and resolves through its own exports map. A
      // catch-all would bypass those exports maps, and would additionally wire a
      // working resolution path for `@closedloop-ai/loops-api` — the package this one is
      // contractually BANNED from importing — inside its own test runner, where
      // nothing ties it to the shrink-only source-gate allowlist ratchet.
      "@repo/design-system": path.resolve(import.meta.dirname),
      "@closedloop-ai/design-system": path.resolve(import.meta.dirname),
    },
  },
});
