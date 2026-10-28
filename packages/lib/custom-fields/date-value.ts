import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { isCustomFieldDateYearInRange } from "@repo/api/src/types/custom-field-date";

/**
 * The DATE custom-field value a renderer may format, or `null`.
 *
 * `dateValue` is typed `Date | null` but arrives as whatever the wire reviver
 * left it: a `Date` for a four-digit ISO year, an Invalid Date for an
 * ISO-shaped junk string, or the raw string for an extended year (ISS-8884).
 * Only a `Date` or a string is constructed from: `new Date(null)`, `new
 * Date(0)` and `new Date(false)` are all 1970-01-01, which the year gate would
 * accept, so absence and any other wire kind resolve to `null`.
 */
export function dateValueAsDate(
  value?: Pick<CustomFieldValueDetail, "dateValue"> | null
): Date | null {
  const raw: unknown = value?.dateValue;
  if (!(raw instanceof Date || typeof raw === "string")) {
    return null;
  }
  const date = new Date(raw);
  return isCustomFieldDateYearInRange(date) ? date : null;
}
