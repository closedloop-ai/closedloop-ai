import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { TransactionClient } from "@repo/database";
import {
  type CustomFieldValueTarget,
  customFieldValueFingerprint,
  readCustomFieldValueFingerprint,
} from "./custom-field-value-fingerprint";
import { CustomFieldsRefusedError } from "./route-helpers";
import { customFieldValuesService } from "./values-service";

/**
 * ISS-12552: applies a project's custom fields inside the project
 * write's own transaction and returns the supplied field ids whose stored
 * value moved. A refused value throws {@link CustomFieldsRefusedError}, so the
 * project write rolls back with it. The caller holds the project row lock, so
 * a value another request committed first is not counted as this one's.
 */
export async function applyProjectCustomFieldsInTransaction(
  tx: TransactionClient,
  customFieldsInput: Record<string, string | number | string[] | null>,
  projectId: string,
  organizationId: string
): Promise<string[]> {
  const movedFieldIds: string[] = [];
  for (const [fieldId, rawValue] of Object.entries(customFieldsInput)) {
    const target = {
      fieldId,
      entityType: CustomFieldEntityType.Project,
      entityId: projectId,
      organizationId,
    };
    const moved =
      rawValue === null
        ? await clearProjectCustomFieldInTransaction(tx, target)
        : await setProjectCustomFieldInTransaction(tx, target, rawValue);
    if (moved) {
      movedFieldIds.push(fieldId);
    }
  }
  return movedFieldIds;
}

/** Sets one project value; true when its stored value moved. */
async function setProjectCustomFieldInTransaction(
  tx: TransactionClient,
  target: CustomFieldValueTarget,
  rawValue: string | number | string[]
): Promise<boolean> {
  const before = await readCustomFieldValueFingerprint(tx, target);
  const result = await customFieldValuesService.setValueForEntityInTransaction(
    tx,
    target.fieldId,
    target.entityType,
    target.entityId,
    target.organizationId,
    rawValue
  );
  if (!result.ok) {
    throw new CustomFieldsRefusedError(result.error);
  }
  const after = await readCustomFieldValueFingerprint(tx, target);
  return (
    customFieldValueFingerprint(before) !== customFieldValueFingerprint(after)
  );
}

/** Clears one project value; true when a stored value was removed. */
async function clearProjectCustomFieldInTransaction(
  tx: TransactionClient,
  target: CustomFieldValueTarget
): Promise<boolean> {
  const deleted = await customFieldValuesService.clearValueInTransaction(
    tx,
    target.fieldId,
    target.entityType,
    target.entityId,
    target.organizationId
  );
  return deleted > 0;
}
