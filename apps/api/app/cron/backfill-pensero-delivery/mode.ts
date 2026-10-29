/**
 * The `?mode=` contract for the Pensero delivery backfill cron (whitlockk, #6747).
 *
 * ## Why parsing is fail-closed
 *
 * `Sweep` is the LIVE, MUTATING backfill — it decrypts every configured
 * organization's Pensero token, writes the ledger, advances the cursors and
 * attaches delivery points. `Validate` is a read-only probe of the same
 * provider. The route used to select between them with a single equality test
 * against the validation word, so ANY other value — `?mode=validatee`,
 * `?mode=dry-run`, `?mode=Validate` — fell through to the sweep. A typo in the
 * one query parameter that names the difference silently turned a dry run into
 * a write across every tenant.
 *
 * So an unrecognised mode is `null` here and a 400 at the route, never a
 * default. An ABSENT `mode` is still `Sweep`, because that is what Vercel Cron
 * sends and changing it would break the schedule — the hazard is a mode the
 * caller NAMED and this route does not know, not a mode it never named.
 */

export const PenseroBackfillMode = {
  Sweep: "sweep",
  Validate: "validate",
} as const;
export type PenseroBackfillMode =
  (typeof PenseroBackfillMode)[keyof typeof PenseroBackfillMode];

/**
 * Derived from the const object rather than written out again, so a mode added
 * above is accepted and advertised without a second edit that can be forgotten.
 */
const ACCEPTED_MODES: readonly string[] = Object.values(PenseroBackfillMode);

/** Every accepted `?mode=` value, for the rejection body. */
export const PENSERO_BACKFILL_MODE_VALUES = ACCEPTED_MODES.join(", ");

/**
 * The requested mode, or `null` when the caller named one this route does not
 * accept. `null` MUST be rejected by the caller; coercing it to a default is
 * the defect this function exists to prevent.
 */
export function parsePenseroBackfillMode(
  rawMode: string | null
): PenseroBackfillMode | null {
  if (rawMode === null) {
    return PenseroBackfillMode.Sweep;
  }
  return isPenseroBackfillMode(rawMode) ? rawMode : null;
}

function isPenseroBackfillMode(value: string): value is PenseroBackfillMode {
  return ACCEPTED_MODES.includes(value);
}
