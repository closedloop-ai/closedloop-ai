/**
 * baseline-org.ts
 *
 * Deterministic baseline org/user identifiers for test reproducibility.
 * Using fixed UUIDs ensures that unit tests produce the same IDs across
 * runs and environments without relying on a real database.
 *
 * Usage:
 * ```ts
 * import { baselineContext, baselineOrg, baselineUser } from "../fixtures/baseline-org";
 *
 * const mock = createMockPrisma();
 * const result = await someFunction(mock, baselineContext);
 * expect(result.organizationId).toBe(baselineOrg.id);
 * ```
 */

import type { SeedContext } from "../../index";

/**
 * Fixed organization ID used across all seed unit tests.
 *
 * Must be a syntactically valid v4 UUID — Postgres `@db.Uuid` columns reject
 * non-hex characters and wrong-length segments. The earlier "test-org0" /
 * "test-usr" literals were not valid UUIDs and caused every integration test
 * to fail at the first FK-bearing insert with `invalid input syntax for type uuid`.
 */
export const BASELINE_ORG_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Fixed user ID used across all seed unit tests.
 *
 * Must be a syntactically valid v4 UUID — see note on BASELINE_ORG_ID.
 */
export const BASELINE_USER_ID = "00000000-0000-4000-8000-000000000002";

/**
 * Minimal baseline organization object for use in test assertions.
 * Extend per-test as needed.
 */
export const baselineOrg = {
  id: BASELINE_ORG_ID,
  name: "Test Organization",
  slug: "test-org",
} as const;

/**
 * Minimal baseline user object for use in test assertions.
 * Extend per-test as needed.
 */
export const baselineUser = {
  id: BASELINE_USER_ID,
  email: "seed-test@example.com",
  name: "Seed Test User",
} as const;

/**
 * A ready-made `SeedContext` built from the baseline IDs.
 * Pass this directly to any seed function under test:
 *
 * ```ts
 * await runSeed(prisma, baselineContext);
 * ```
 */
export const baselineContext: SeedContext = {
  organizationId: BASELINE_ORG_ID,
  userId: BASELINE_USER_ID,
};
