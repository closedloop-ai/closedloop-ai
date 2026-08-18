import { z } from "zod";

const prismaErrorCodeSchema = z.object({ code: z.string() }).passthrough();
const prismaP2002MetaSchema = z
  .object({
    code: z.literal("P2002"),
    meta: z.object({ target: z.unknown() }),
  })
  .passthrough();
/** A PostgreSQL SQLSTATE: five alphanumeric characters, e.g. `55P03`. */
const SQL_STATE_PATTERN = /^[0-9A-Z]{5}$/;
/**
 * Prisma's own error codes (`P1002`, `P2002`, `P2010`, …).
 *
 * These are also five `[0-9A-Z]` characters, so {@link SQL_STATE_PATTERN} alone
 * would happily return `P2002` as if it were a server-side SQLSTATE. Prisma
 * uses `P` + a NON-zero digit + three digits, which leaves PostgreSQL's real
 * `P0xxx` class (`P0001` raise_exception, `P0002` no_data_found) correctly
 * treated as a SQLSTATE.
 */
const PRISMA_ERROR_CODE_PATTERN = /^P[1-9]\d{3}$/;
const prismaRawQueryMetaSchema = z
  .object({ meta: z.object({ code: z.string() }).passthrough() })
  .passthrough();

export const basicUserSelect = {
  select: {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    avatarUrl: true,
  },
} as const;

/** Extracts a Prisma error code from unknown caught errors without casts. */
export function getPrismaErrorCode(error: unknown): string | undefined {
  const parsed = prismaErrorCodeSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

/**
 * Extracts the Prisma P2002 unique-constraint target from unknown caught errors.
 *
 * Prisma adapters report `meta.target` with different shapes, so callers keep the
 * value unknown and decide how to match the relevant constraint name or fields.
 */
export function getPrismaP2002Target(error: unknown): unknown {
  const parsed = prismaP2002MetaSchema.safeParse(error);
  return parsed.success ? parsed.data.meta.target : undefined;
}

/**
 * Extracts the underlying PostgreSQL SQLSTATE from a failed raw query.
 *
 * Prisma does not surface the SQLSTATE on `code` for raw queries — `code` is
 * Prisma's own `P2010` ("Raw query failed") and the driver's five-character
 * SQLSTATE lives in `meta.code`. Callers that branch on a specific server-side
 * condition (a `lock_timeout`, a `statement_timeout`, a constraint) must read it
 * from there, so checking `error.code` alone silently never matches.
 *
 * Some adapters surface the SQLSTATE directly on `code` instead, so both shapes
 * are accepted: a five-character SQLSTATE on `code` is returned as-is, otherwise
 * `meta.code` is used.
 */
export function getPrismaRawQuerySqlState(error: unknown): string | undefined {
  const metaParsed = prismaRawQueryMetaSchema.safeParse(error);
  if (metaParsed.success) {
    return metaParsed.data.meta.code;
  }

  const code = getPrismaErrorCode(error);
  if (
    code === undefined ||
    !SQL_STATE_PATTERN.test(code) ||
    PRISMA_ERROR_CODE_PATTERN.test(code)
  ) {
    return undefined;
  }
  return code;
}
