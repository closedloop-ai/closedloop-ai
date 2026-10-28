import { pinnedReporters } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

/**
 * `pnpm test:integration`: suites against a real Redis (and, for the listener,
 * a real Postgres). `pr-test.yml`'s `realtime-integration-tests` job provides
 * both on a pull request; a run without them prints a loud skip from the global
 * setup.
 */
export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    include: ["src/**/*.integration.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    globalSetup: ["src/__tests__/integration/announce-skips.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
