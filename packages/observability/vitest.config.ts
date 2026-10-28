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
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@repo/cost": path.resolve(import.meta.dirname, "../cost/src"),
      "@repo/loops-api": path.resolve(import.meta.dirname, "../loops-api/src"),
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../loops-api/src"
      ),
      // ISS-7401: MUST precede the bare-specifier entry below — Vite takes the
      // first matching prefix. `sync.ts` sits at the package root, not under
      // `src/`, so the broad alias resolves this subpath to a file that does
      // not exist. Without this entry a test cannot import the canonical
      // `SyncLane`, which is what let the wire schema's hand-written lane
      // mirror go unpinned.
      "@closedloop-ai/telemetry-contract/sync": path.resolve(
        import.meta.dirname,
        "../telemetry-contract/sync.ts"
      ),
      "@closedloop-ai/telemetry-contract": path.resolve(
        import.meta.dirname,
        "../telemetry-contract/src"
      ),
    },
  },
});
