/**
 * Postgres column ceilings shared by validators.
 *
 * Import-free on purpose, and declared HERE rather than imported from
 * `@repo/api`: `packages/api` already depends on `@closedloop-ai/loops-api`
 * (`packages/api/package.json`), so the reverse import would close a workspace
 * cycle `@closedloop-ai/loops-api -> @repo/api -> @closedloop-ai/loops-api`.
 *
 * `PR_INT_MAX` (`packages/api/src/types/session-artifact-link.ts`) derives from
 * this one.
 */

/**
 * Postgres `int4` max. A value past this reaching a Prisma `Int` column raises
 * `22003 integer out of range` at the driver (ISS-8564).
 */
export const POSTGRES_INT4_MAX = 2_147_483_647;

/**
 * Postgres `int4` min, the floor half of the same column bound.
 *
 * Declared because a validator that bounds only the ceiling still lets `-1e21`
 * — `Number.isInteger` says `true` — reach an `Int` column and raise the same
 * `22003 integer out of range`. Bounding at the column's real floor closes that
 * arm without refusing a negative the column accepts today; a floor of `0` is a
 * PRODUCT rule about a field's meaning, not a column bound, and belongs only
 * where a caller was already refused one.
 */
export const POSTGRES_INT4_MIN = -2_147_483_648;
