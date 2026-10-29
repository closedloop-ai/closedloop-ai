import path from "node:path";
import {
  automaticJsx,
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Not redundant with this package's own `jsx: react-jsx`: a sibling package's
  // `.tsx`, resolved from source by the aliases below, transforms under that
  // package's tsconfig, and `@repo/rich-text`'s is the Next preset's
  // `jsx: "preserve"`.
  oxc: automaticJsx(),
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
      "@repo/design-system": path.resolve(
        import.meta.dirname,
        "../design-system"
      ),
      "@closedloop-ai/design-system": path.resolve(
        import.meta.dirname,
        "../design-system"
      ),
      "@repo/loops-api": path.resolve(import.meta.dirname, "../loops-api/src"),
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../loops-api/src"
      ),
      "@closedloop-ai/shared-platform": path.resolve(
        import.meta.dirname,
        "../shared-platform/src"
      ),
      "@repo/shared-platform": path.resolve(
        import.meta.dirname,
        "../shared-platform/src"
      ),
      // `@repo/rich-text` builds from `@repo/document-schema` (ISS-12503),
      // whose subpaths resolve under `src/` too.
      "@repo/document-schema": path.resolve(
        import.meta.dirname,
        "../document-schema/src"
      ),
      // `shared/realtime` (PLN-2106) reads the realtime client, whose subpaths,
      // and those of the contract it imports, resolve under `src/`.
      "@repo/realtime-client": path.resolve(
        import.meta.dirname,
        "../realtime-client/src"
      ),
      "@repo/realtime-contract": path.resolve(
        import.meta.dirname,
        "../realtime-contract/src"
      ),
      "@repo": path.resolve(import.meta.dirname, ".."),
    },
  },
});
