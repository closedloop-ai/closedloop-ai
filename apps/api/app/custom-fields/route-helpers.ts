import type {
  CustomFieldEntityType,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { customFieldValuesService } from "./values-service";

/**
 * Merges custom field values into an entity response.
 *
 * Fetches all custom field values for the entity and returns the entity spread
 * with a `customFields` array (always present, never undefined).
 *
 * @param entity - The entity to merge custom fields into. Must have an `id` field.
 * @param entityType - The custom field entity type (Project, Workstream, Feature, Artifact).
 * @param organizationId - The organization ID for scoping.
 * @returns The entity spread with `customFields: CustomFieldValueDetail[]`.
 */
export async function mergeCustomFieldsIntoResponse<T extends { id: string }>(
  entity: T,
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  organizationId: string
): Promise<T & { customFields: CustomFieldValueDetail[] }> {
  const customFields = await customFieldValuesService.getValuesForEntity(
    entityType,
    entity.id,
    organizationId
  );

  return { ...entity, customFields };
}

/**
 * Applies custom field values from a request body to an entity.
 *
 * Iterates over each entry in `customFieldsInput`:
 * - If the value is non-null, calls `setValueForEntity` to upsert the value.
 * - If the value is null, calls `clearValue` to remove the value.
 *
 * **Known limitation:** Writes are applied sequentially without a wrapping
 * transaction. If an error occurs mid-loop, previously applied values will
 * persist (partial write). A proper fix would require passing a transaction
 * handle through the service methods.
 *
 * @param customFieldsInput - Map of customFieldId → raw value (or null to clear).
 * @param entityId - The entity instance ID.
 * @param entityType - The custom field entity type.
 * @param organizationId - The organization ID for scoping.
 */
export async function applyCustomFieldsFromBody(
  customFieldsInput: Record<string, unknown>,
  entityId: string,
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  organizationId: string
): Promise<void> {
  for (const [fieldId, rawValue] of Object.entries(customFieldsInput)) {
    if (rawValue === null) {
      await customFieldValuesService.clearValue(
        fieldId,
        entityType,
        entityId,
        organizationId
      );
    } else {
      await customFieldValuesService.setValueForEntity(
        fieldId,
        entityType,
        entityId,
        organizationId,
        rawValue as string | number | string[]
      );
    }
  }
}
