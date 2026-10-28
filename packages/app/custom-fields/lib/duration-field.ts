import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";

/**
 * The one place that answers "is this field edited as a duration?".
 *
 * ISS-8213. A duration is a NUMBER field whose canonical storage unit is
 * milliseconds (`NumberFormat.Duration`, declared in
 * `@repo/api/src/types/custom-field`), so `fieldType` alone cannot tell the
 * cases apart — the detail-panel editor keyed on the SHAPE and parsed spans,
 * while the table cell keyed on `fieldType` and sent `Number(draft)`. The two
 * then disagreed about the unit: `1h 12m` was refused in the grid and accepted
 * in the panel, and a bare `90` meant 90 milliseconds in one and 90 seconds in
 * the other.
 *
 * Deliberately takes NO feature-flag argument. The Duration format ships behind
 * `CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY`, and each surface reads that
 * key at its own swap site and branches there — threading the boolean in here
 * would put one flag behind two derivations that can settle differently (root
 * `AGENTS.md`, "One read site per feature flag").
 */
export function isDurationFormattedField(
  field: Pick<CustomFieldWithOptions, "fieldType" | "numberFormat">
): boolean {
  return (
    field.fieldType === CustomFieldType.Number &&
    field.numberFormat === NumberFormat.Duration
  );
}

/**
 * The refusal copy for an unparseable span, named once so the grid cell and the
 * detail editor cannot drift into two sentences for one rejection.
 */
export function durationValidationMessage(input: string): string {
  return `"${input}" isn't a duration — try "1h 12m" or "90s".`;
}
