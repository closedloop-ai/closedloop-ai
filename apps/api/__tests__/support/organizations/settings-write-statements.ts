import type { RenderedSqlStatement } from "@/__tests__/support/organizations/render-settings-sql";

/**
 * ISS-7157: a settings write is TWO statements inside one transaction, not one.
 *
 * The caller's `jsonb_set` UPDATE runs first and is what takes the row lock;
 * `writeOrganizationSettings` then reads the clock — a reading it can only make
 * once that lock is held — and applies it with a second `updated_at` UPDATE.
 * The caller's own bound stamp is a floor, captured before the write waited on
 * anything, so it cannot be the value the column ends up carrying.
 *
 * The count is a shared constant because three suites assert it and each would
 * otherwise carry its own bare `2` and its own copy of that explanation. A
 * refused write is the exception and is deliberately not covered here: the
 * row-count guards throw between the two statements, so nothing is stamped and
 * the caller sees exactly one call.
 */
export const SETTINGS_WRITE_STATEMENT_COUNT = 2;

export type OrganizationSettingsWriteStatements = {
  /** The caller's `jsonb_set` patch — the statement that takes the row lock. */
  readonly settings: RenderedSqlStatement;
  /** The post-lock `updated_at` re-stamp the shared writer appends. */
  readonly stamp: RenderedSqlStatement;
};

/**
 * Both statements a settings write issued, from a `$executeRaw` double's
 * recorded calls.
 *
 * The two arrive in different shapes and the difference is not cosmetic: the
 * caller hands a composed `Prisma.sql` value, while the shared writer tags the
 * template on `$executeRaw` itself, so its call is `(strings, ...values)`.
 * Normalising here keeps that detail out of three suites.
 */
export function organizationSettingsWriteStatements(
  calls: readonly (readonly unknown[])[]
): OrganizationSettingsWriteStatements {
  if (calls.length !== SETTINGS_WRITE_STATEMENT_COUNT) {
    throw new Error(
      `expected ${SETTINGS_WRITE_STATEMENT_COUNT} settings-write statements, captured ${calls.length}`
    );
  }
  const [settingsCall, stampCall] = calls;
  const [strings, ...values] = stampCall;
  const segments = [...(strings as readonly string[])];
  return {
    settings: settingsCall[0] as RenderedSqlStatement,
    stamp: { strings: segments, text: segments.join("?"), values },
  };
}
