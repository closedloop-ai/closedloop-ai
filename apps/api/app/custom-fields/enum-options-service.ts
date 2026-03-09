import type {
  CreateEnumOptionInput,
  CustomFieldEnumOption,
  UpdateEnumOptionInput,
} from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";

import { checkOptionLimit, computeDisplayValue } from "./utils";

/**
 * Verifies that a custom field belongs to the given organization.
 * Returns the field with its enum options, or throws if not found.
 */
async function verifyFieldOwnership(
  customFieldId: string,
  organizationId: string
) {
  const field = await withDb((db) =>
    db.customField.findFirst({
      where: { id: customFieldId, organizationId },
      include: { enumOptions: { orderBy: { sortOrder: "asc" } } },
    })
  );

  if (!field) {
    throw new Error(
      "Custom field not found or does not belong to organization."
    );
  }

  return field;
}

/**
 * Converts a Prisma CustomFieldEnumOption record to the API type.
 */
function toEnumOption(row: {
  id: string;
  customFieldId: string;
  name: string;
  color: string;
  enabled: boolean;
  sortOrder: number;
}): CustomFieldEnumOption {
  return {
    id: row.id,
    customFieldId: row.customFieldId,
    name: row.name,
    color: row.color,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
  };
}

/**
 * Service functions for managing enum options on custom fields.
 */
export const enumOptionsService = {
  /**
   * Creates a new enum option on a custom field.
   *
   * Verifies field ownership, enforces the 100-option limit, then creates
   * the option with sortOrder = current count (appended at end).
   */
  async createEnumOption(
    customFieldId: string,
    organizationId: string,
    input: CreateEnumOptionInput
  ): Promise<CustomFieldEnumOption> {
    await verifyFieldOwnership(customFieldId, organizationId);
    await checkOptionLimit(customFieldId);

    const created = await withDb(async (db) => {
      const currentCount = await db.customFieldEnumOption.count({
        where: { customFieldId },
      });

      return db.customFieldEnumOption.create({
        data: {
          customFieldId,
          name: input.name,
          color: input.color ?? "none",
          enabled: input.enabled ?? true,
          sortOrder: input.sortOrder ?? currentCount,
        },
      });
    });

    return toEnumOption(created);
  },

  /**
   * Updates an enum option's name, color, or enabled state.
   *
   * Verifies field ownership before updating. If the name changed, recalculates
   * the displayValue for all CustomFieldValue rows that reference this option
   * (via enumValueId for ENUM fields, or multiEnumValueIds for MULTI_ENUM fields).
   */
  async updateEnumOption(
    optionId: string,
    customFieldId: string,
    organizationId: string,
    input: UpdateEnumOptionInput
  ): Promise<CustomFieldEnumOption> {
    const field = await verifyFieldOwnership(customFieldId, organizationId);

    const updated = await withDb.tx(async (tx) => {
      const option = await tx.customFieldEnumOption.update({
        where: { id: optionId, customFieldId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        },
      });

      if (input.name !== undefined) {
        // Build updated options list (replace stale option with updated name)
        const updatedOptions = field.enumOptions.map((opt) =>
          opt.id === optionId ? { ...opt, name: input.name as string } : opt
        );

        const fieldWithUpdatedOptions = {
          ...field,
          enumOptions: updatedOptions,
        };

        // Find all CustomFieldValue rows referencing this option
        const affectedValues = await tx.customFieldValue.findMany({
          where: {
            customFieldId,
            OR: [
              { enumValueId: optionId },
              { multiEnumValueIds: { hasSome: [optionId] } },
            ],
          },
        });

        // Recalculate displayValue for each affected row
        await Promise.all(
          affectedValues.map(async (cfv) => {
            const rawValue =
              cfv.enumValueId !== null
                ? cfv.enumValueId
                : cfv.multiEnumValueIds;

            const displayValue = await computeDisplayValue(
              fieldWithUpdatedOptions,
              rawValue,
              updatedOptions
            );

            return tx.customFieldValue.update({
              where: { id: cfv.id },
              data: { displayValue },
            });
          })
        );
      }

      return option;
    });

    return toEnumOption(updated);
  },

  /**
   * Reorders enum options by updating each option's sortOrder to match
   * its position in the provided orderedOptionIds array.
   *
   * Verifies field ownership before updating. All sortOrder updates run
   * in a single transaction.
   */
  async reorderEnumOptions(
    customFieldId: string,
    organizationId: string,
    orderedOptionIds: string[]
  ): Promise<void> {
    const field = await verifyFieldOwnership(customFieldId, organizationId);

    if (orderedOptionIds.length !== field.enumOptions.length) {
      throw new Error(
        `Expected ${field.enumOptions.length} option IDs but received ${orderedOptionIds.length}. All options must be included in the reorder list.`
      );
    }

    await withDb.tx(async (tx) => {
      await Promise.all(
        orderedOptionIds.map((optionId, index) =>
          tx.customFieldEnumOption.update({
            where: { id: optionId, customFieldId },
            data: { sortOrder: index },
          })
        )
      );
    });
  },
};
