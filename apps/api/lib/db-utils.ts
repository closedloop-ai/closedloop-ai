import { log } from "@repo/observability/log";
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
// Pinned to P2010 for the same reason the adapter shape below is: this is a
// RAW-QUERY reader, and leaving the legacy branch open to any Prisma code would
// let a non-raw error answer through the first branch while the second refuses
// it — the looser of two branches decides, so the gate has to be on both.
const prismaRawQueryMetaSchema = z
  .object({
    code: z.literal("P2010"),
    meta: z.object({ code: z.string() }).passthrough(),
  })
  .passthrough();

/**
 * ISS-8556: the shape Prisma 7.10's `@prisma/adapter-pg` actually uses for a
 * failed RAW query. It no longer sets `meta.code`; the driver SQLSTATE moved to
 * `meta.driverAdapterError.cause.originalCode`, alongside the same
 * `driverAdapterError` envelope P2002 already reported.
 *
 * This was a live regression, not a hypothetical: with only the `meta.code`
 * shape, `getPrismaRawQuerySqlState` returned `undefined` for every real raw
 * query on 7.10, and `p2010-raw-query-sqlstate-realdb.test.ts` is what caught
 * it and is what keeps this envelope pinned against a real database.
 *
 * The caller it was caught THROUGH no longer travels this shape: ISS-5978 moved
 * the preview-schema DROP off the runtime pool onto a bare `pg` client, so a
 * lock-contended drop now raises its SQLSTATE on `code` and `isDropContentionError`
 * reads it through that branch instead (unit-pinned in
 * `__tests__/unit/db-utils-sqlstate.test.ts`). What this envelope still covers
 * with a real database is the remaining raw-query callers — the stale-session
 * reaper on 55P03, the commit batch update on 23505.
 */
const prismaRawQueryDriverAdapterSchema = z
  .object({
    // Pinned to P2010 so this stays a RAW-QUERY reader. A P2002 carries the
    // same `driverAdapterError.cause` envelope with `originalCode: "23505"`,
    // and without this literal `getPrismaRawQuerySqlState` would answer for it
    // — widening the function's domain past its own name and docstring.
    code: z.literal("P2010"),
    meta: z
      .object({
        driverAdapterError: z
          .object({
            cause: z.object({ originalCode: z.string() }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
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
 *
 * **This reads `meta.target` ONLY, and the pg driver adapter does not set it**
 * (ISS-7536) — see {@link getPrismaP2002ConstraintTarget}. A caller that
 * discriminates a constraint must consult BOTH, or it silently matches nothing
 * on that adapter and re-throws a conflict it meant to map.
 */
export function getPrismaP2002Target(error: unknown): unknown {
  const parsed = prismaP2002MetaSchema.safeParse(error);
  return parsed.success ? parsed.data.meta.target : undefined;
}

/**
 * Applies `matches` to whichever P2002 target shape is present, because only
 * one is populated at a time: the pg driver adapter this app runs on fills
 * `meta.driverAdapterError.cause.constraint` and leaves `meta.target` unset,
 * while other adapters do the reverse.
 *
 * ISS-8804: consulting {@link getPrismaP2002Target} alone is why six conflict
 * branches were dead code — measured, not suspected, by
 * apps/api/__tests__/integration/p2002-adapter-payload-realdb.test.ts. Use this
 * rather than either extractor directly, so a caller cannot re-introduce the
 * half-check.
 *
 * An ABSENT shape is skipped rather than passed to `matches` — absent meaning
 * `undefined` OR `null`, since `meta.target` is typed `z.unknown()` and a null
 * parses. That is the ONLY thing this skip buys: `matches` is never called with
 * `undefined`.
 *
 * IT DOES NOT MAKE A LOOSE MATCHER SAFE, and an earlier draft of this comment
 * claimed it did. A negation-shaped matcher (`(t) => !Array.isArray(t)`) still
 * matches every real adapter-pg P2002, because the surviving shape is the index
 * NAME STRING and `!Array.isArray("organizations_slug_key")` is true. Narrowing
 * is a CALLER obligation this helper cannot discharge: the matcher must
 * positively identify its own index name, compared EXACTLY — `teams` and
 * `promote` were tightened from substring tests for exactly this reason, and
 * `organizations_slug_key` is a substring-collision away from being read as a
 * team's slug conflict.
 *
 * `matches` receives an index NAME string on adapter-pg (e.g.
 * `organizations_slug_key`) and a field-name array on adapters that report one,
 * so a matcher has to accept both — and the two need DIFFERENT rules. An exact
 * comparison is possible against the name; a bare column list names no table,
 * so an array matcher should require the whole column SET (see
 * `matchesArtifactLinkUniqueTarget`) rather than membership.
 *
 * WHEN A P2002 CARRIES NEITHER SHAPE THIS WARNS RATHER THAN FAILING SILENTLY.
 * That silence is how the branches died: every previous envelope move
 * (ISS-7536, ISS-8556, ISS-8804) turned N conflict branches into dead code
 * while the suite stayed green, because a matcher that is never called and a
 * matcher that returns false are indistinguishable from the outside. Routing
 * five callers through one helper concentrates that risk, so the helper is
 * where the alarm belongs. It logs the meta KEYS, never a value, so a
 * constraint name or column list cannot reach the log.
 *
 * It stays a warning, not a throw: the caller's own answer (`false` — not my
 * conflict) is still the correct conservative outcome, and a P2002 arriving in
 * a shape nobody anticipated must not become a 500 on a path that was
 * previously merely wrong.
 */
export function matchesPrismaP2002Target(
  error: unknown,
  matches: (target: unknown) => boolean
): boolean {
  const target = getPrismaP2002Target(error);
  if (target != null && matches(target)) {
    return true;
  }
  const constraint = getPrismaP2002ConstraintTarget(error);
  if (constraint != null) {
    return matches(constraint);
  }
  if (getPrismaErrorCode(error) === "P2002") {
    log.warn(
      "P2002 carried neither target shape; conflict branch cannot fire",
      {
        code: "P2002",
        meta: {
          targetType: target == null ? "absent" : typeof target,
          constraintPresent: false,
        },
      }
    );
  }
  return false;
}

const prismaP2002ConstraintSchema = z
  .object({
    code: z.literal("P2002"),
    meta: z
      .object({
        driverAdapterError: z
          .object({
            cause: z
              .object({
                constraint: z.union([
                  z.object({ fields: z.array(z.string()) }),
                  z.object({ index: z.string() }),
                ]),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Extracts the violated constraint from a P2002 raised through a Prisma driver
 * adapter.
 *
 * Prisma 7's `@prisma/adapter-pg` reports the constraint under
 * `meta.driverAdapterError.cause.constraint` and leaves `meta.target` UNSET, so
 * {@link getPrismaP2002Target} alone returns `undefined` for every real P2002 on
 * that adapter — a discriminating caller then silently stops recognizing its own
 * constraint. Callers should consult both extractors.
 *
 * Returns the constraint's column list, or the index name for adapters that
 * report one instead; `undefined` when neither shape is present.
 */
export function getPrismaP2002ConstraintTarget(error: unknown): unknown {
  const parsed = prismaP2002ConstraintSchema.safeParse(error);
  if (!parsed.success) {
    return undefined;
  }
  const { constraint } = parsed.data.meta.driverAdapterError.cause;
  return "fields" in constraint ? constraint.fields : constraint.index;
}

/**
 * The driver SQLSTATE for a failed RAW query, across the three envelopes Prisma
 * has used, tried in this order:
 *
 * 1. `meta.code` — the pre-7.10 shape, and what other adapters may still send.
 * 2. `meta.driverAdapterError.cause.originalCode` — what `@prisma/adapter-pg`
 *    emits on 7.10. THIS is the live shape for this app.
 * 3. a bare SQLSTATE on `code`, for a driver error that never became a Prisma
 *    envelope. Validated, so Prisma's own `P####` codes cannot be mistaken for
 *    one.
 *
 * Returns `undefined` when none is present. Callers discriminate on the value,
 * so a wrong answer here silently turns a whole branch into dead code — which
 * is what happened when only shape 1 was read (ISS-8556).
 */
export function getPrismaRawQuerySqlState(error: unknown): string | undefined {
  // Validated, not returned verbatim: `meta.code` is typed only as a string, so
  // an adapter putting a non-SQLSTATE there would otherwise be handed straight
  // to a caller that discriminates on the value.
  const metaParsed = prismaRawQueryMetaSchema.safeParse(error);
  if (metaParsed.success && isDriverSqlState(metaParsed.data.meta.code)) {
    return metaParsed.data.meta.code;
  }

  // The 7.10 adapter-pg shape. Checked after `meta.code` so an adapter that
  // still reports the older envelope keeps winning, and before the `code`
  // fallback below, which only ever sees a bare SQLSTATE.
  const adapterParsed = prismaRawQueryDriverAdapterSchema.safeParse(error);
  if (adapterParsed.success) {
    return adapterParsed.data.meta.driverAdapterError.cause.originalCode;
  }

  const code = getPrismaErrorCode(error);
  return code !== undefined && isDriverSqlState(code) ? code : undefined;
}

/** A five-character driver SQLSTATE, and not one of Prisma's own `P####`. */
function isDriverSqlState(candidate: string): boolean {
  return (
    SQL_STATE_PATTERN.test(candidate) &&
    !PRISMA_ERROR_CODE_PATTERN.test(candidate)
  );
}

const prismaDriverAdapterSqlStateSchema = z
  .object({
    meta: z
      .object({
        driverAdapterError: z
          .object({
            cause: z.object({ originalCode: z.string() }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * The driver SQLSTATE `@prisma/adapter-pg` reports for ANY failed query, model
 * or raw. {@link getPrismaRawQuerySqlState} is pinned to P2010, and a model query
 * on 7.10 carries another Prisma code (P2039 for a statement refused on an
 * aborted transaction) over the same `driverAdapterError.cause.originalCode`.
 */
export function getPrismaDriverAdapterSqlState(
  error: unknown
): string | undefined {
  const parsed = prismaDriverAdapterSqlStateSchema.safeParse(error);
  const code = parsed.success
    ? parsed.data.meta.driverAdapterError.cause.originalCode
    : undefined;
  return code !== undefined && isDriverSqlState(code) ? code : undefined;
}

const PRISMA_INCONSISTENT_COLUMN_DATA = "P2023";
const UNKNOWN_ENUM_VALUE_LINE = /.*not found in enum.*/;

/**
 * Whether `error` is Prisma refusing a stored enum value its generated client
 * has no member for — "Value 'X' not found in enum 'Y'", raised on the READ when
 * a migration has added the value ahead of this build (ISS-9481, ISS-11071).
 * Matched on the message too: the same mapper raises P2023 for other
 * inconsistent column data (an integer column holding text, pinned in
 * `app/custom-fields/find-by-org-unknown-enum.integration.test.ts`), which
 * callers must not absorb as version skew.
 */
export function isUnknownEnumValueError(error: unknown): error is Error {
  return (
    getPrismaErrorCode(error) === PRISMA_INCONSISTENT_COLUMN_DATA &&
    error instanceof Error &&
    UNKNOWN_ENUM_VALUE_LINE.test(error.message)
  );
}

/**
 * The line of an {@link isUnknownEnumValueError} message that names the value
 * and enum, without Prisma's invocation frame. Same pattern as the classifier,
 * so an error it accepts always yields a line.
 */
export function unknownEnumValueLine(error: Error): string | undefined {
  return error.message.match(UNKNOWN_ENUM_VALUE_LINE)?.[0];
}
