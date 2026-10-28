import { pinnedReporters } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

/**
 * `pnpm test:integration`: suites against a real Postgres (`DOC_SYNC_TEST_PG_*`).
 * `pr-test.yml`'s `doc-sync-integration-tests` job provides one; a run without
 * it prints a loud skip from the global setup.
 */
export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    include: ["src/**/*.integration.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    globalSetup: ["src/__tests__/integration/announce-skips.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 20_000,
  },
});
