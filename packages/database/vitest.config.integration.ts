import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SEED_DB_TEST_TIMEOUT_MS } from "./scripts/seed/__tests__/timeouts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Dedicated config for database integration suites (run via `pnpm test:integration`).
//
// Self-contained (mirrors vitest.config.compatibility.mts) rather than merged
// onto the base config: mergeConfig concatenates arrays, so inheriting a future
// `test.include` from the base config would silently broaden this run. Owning
// the full config keeps the integration scope explicit and decoupled.
//
// These tests use real database boundaries, including seeding real Postgres and
// spawning the real `pnpm seed` binary in a few seed suites, which exceeds
// Vitest's 5s default under CI/parallel load. Budget the whole run here (see
// SEED_DB_TEST_TIMEOUT_MS) so individual suites don't each have to remember a
// per-test timeout. The unit config (`pnpm test:unit`, the default
// vitest.config.ts) keeps the fast 5s default so unit hangs fail fast.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "scripts/seed/__tests__/integration/**/*.test.ts",
      "__tests__/integration/**/*.test.ts",
    ],
    testTimeout: SEED_DB_TEST_TIMEOUT_MS,
    hookTimeout: SEED_DB_TEST_TIMEOUT_MS,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(
        __dirname,
        "../../apps/app/vitest-mocks/server-only.ts"
      ),
    },
  },
});
