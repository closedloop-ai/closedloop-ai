import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    globals: true,
    environment: "node",
    // ISS-7168. This config had no `exclude`, so what kept the 20 real-Postgres
    // suites out of the unit tier was a `--exclude` flag on the `test:unit`
    // SCRIPT, not the config — a bare `vitest run` here (an IDE, an ad-hoc
    // invocation, a future script that forgets the flag) collected all 20 at
    // Vitest's 5s default against a contended database, which is precisely the
    // apps/api bug this ticket is named for. Owning the exclusion in the config
    // makes the tier boundary a property of the package rather than of one
    // command line; `test:unit` is now a plain `vitest run`. Collection is
    // unchanged either way (85 files, verified both invocations), so this is
    // hardening plus de-duplication, not a fix to a live double-collection.
    // These globs mirror vitest.config.integration.ts's `include` exactly.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "__tests__/integration/**",
      "scripts/seed/__tests__/integration/**",
    ],
  },
  resolve: {
    alias: {
      "server-only": path.resolve(
        __dirname,
        "../typescript-config/vitest-server-only-stub.ts"
      ),
    },
  },
});
