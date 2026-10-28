import {
  CUSTOM_FIELD_ENTITY_API_SEGMENT,
  type CustomFieldEntityType,
  type CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";

/** The one URL builder for an entity's `GET .../custom-field-values` (ISS-12302). */
export function readEntityCustomFieldValues(
  api: { get<T>(path: string): Promise<T> },
  entityType: CustomFieldEntityType,
  entityId: string
): Promise<CustomFieldValueDetail[]> {
  return api.get<CustomFieldValueDetail[]>(
    `/${CUSTOM_FIELD_ENTITY_API_SEGMENT[entityType]}/${entityId}/custom-field-values`
  );
}
