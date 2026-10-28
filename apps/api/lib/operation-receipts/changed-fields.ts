/**
 * ISS-12552: the fields a write asked for whose stored value actually moved,
 * for a receipt's `changedFields`. An unchanged re-save returns an empty list,
 * which makes the write a no-op (PRD-800 "No-op writes").
 */
export function fieldsThatMoved<Field extends string>(
  fields: readonly Field[],
  requested: Partial<Record<Field, unknown>>,
  previous: Partial<Record<Field, unknown>>,
  next: Partial<Record<Field, unknown>>
): Field[] {
  return fields.filter(
    (field) =>
      field in requested &&
      comparable(previous[field]) !== comparable(next[field])
  );
}

function comparable(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value ?? null);
}

/** Prefix for a custom field id in a receipt's `changedFields`. */
export const CUSTOM_FIELD_CHANGE_PREFIX = "customField:";

/** The `changedFields` entries for the custom fields a write moved. */
export function customFieldChanges(fieldIds: readonly string[]): string[] {
  return fieldIds.map((fieldId) => `${CUSTOM_FIELD_CHANGE_PREFIX}${fieldId}`);
}
