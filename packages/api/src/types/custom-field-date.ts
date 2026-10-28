/**
 * Year bounds for DATE custom-field values (ISS-8884).
 *
 * The wire reviver (`packages/app/shared/api/revive-with-dates.ts`) recognizes
 * only a four-digit ISO year and the HTML date input stops at 9999-12-31, so a
 * value outside 0001..9999 (UTC) is refused at ingest and degraded at render
 * instead of being persisted as a value no consumer can revive.
 *
 * Dependency-free on purpose: the table cell imports it on a bundle-sensitive
 * client surface and the API validator imports the same predicate, so the two
 * cannot drift.
 */

export const CUSTOM_FIELD_DATE_MIN_YEAR = 1;
export const CUSTOM_FIELD_DATE_MAX_YEAR = 9999;
export const CUSTOM_FIELD_DATE_MAX = "9999-12-31";

export function isCustomFieldDateYearInRange(date: Date): boolean {
  if (!Number.isFinite(date.getTime())) {
    return false;
  }
  const year = date.getUTCFullYear();
  return (
    year >= CUSTOM_FIELD_DATE_MIN_YEAR && year <= CUSTOM_FIELD_DATE_MAX_YEAR
  );
}
