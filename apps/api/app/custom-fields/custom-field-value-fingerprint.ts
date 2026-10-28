import type { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { TransactionClient } from "@repo/database";

/** One entity's stored value for one custom field, located by its keys. */
export type CustomFieldValueTarget = {
  fieldId: string;
  entityType: CustomFieldEntityType;
  entityId: string;
  organizationId: string;
};

/**
 * Every stored part of one custom field value, read on the write's own
 * transaction so a write can tell whether it moved the value.
 */
export function readCustomFieldValueFingerprint(
  tx: TransactionClient,
  target: CustomFieldValueTarget
) {
  return tx.customFieldValue.findFirst({
    where: {
      customFieldId: target.fieldId,
      entityType: target.entityType,
      entityId: target.entityId,
      organizationId: target.organizationId,
    },
    select: {
      textValue: true,
      numberValue: true,
      dateValue: true,
      enumValueId: true,
      multiEnumValueIds: true,
      peopleValueIds: true,
      references: {
        orderBy: { sortOrder: "asc" },
        select: { targetArtifactId: true, sortOrder: true },
      },
    },
  });
}

export function customFieldValueFingerprint(
  value: Awaited<ReturnType<typeof readCustomFieldValueFingerprint>>
): string {
  return JSON.stringify(value);
}
