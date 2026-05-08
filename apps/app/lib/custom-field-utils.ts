import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";

/**
 * Derives distinct custom field column definitions from a list of entities.
 *
 * Iterates over all entities' `customFields` arrays, collecting the first
 * CustomFieldValueDetail seen for each customFieldId. Only includes fields
 * where `showInTable` is true (configured on the field definition).
 *
 * @param entities - Array of entities that may have a `customFields` property.
 * @returns De-duplicated array of CustomFieldValueDetail (one per custom field).
 */
export function deriveCustomFieldColumns(
  entities: { customFields?: CustomFieldValueDetail[] }[]
): CustomFieldValueDetail[] {
  const seen = new Map<string, CustomFieldValueDetail>();
  for (const entity of entities) {
    for (const field of entity.customFields ?? []) {
      if (!seen.has(field.customFieldId) && field.showInTable) {
        seen.set(field.customFieldId, field);
      }
    }
  }
  return Array.from(seen.values());
}
