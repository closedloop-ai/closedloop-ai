import type {
  CreateEnumOptionInput,
  CustomFieldEnumOption,
  UpdateEnumOptionInput,
} from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { Prisma, type TransactionClient, withDb } from "@repo/database";

import { checkOptionLimit, MULTI_ENUM_DISPLAY_SEPARATOR } from "./utils";

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
   * the cached displayValue for all CustomFieldValue rows that reference this
   * option — via enumValueId for ENUM fields, or multiEnumValueIds for
   * MULTI_ENUM fields — in one set-based statement per field type.
   */
  async updateEnumOption(
    optionId: string,
    customFieldId: string,
    organizationId: string,
    input: UpdateEnumOptionInput
  ): Promise<CustomFieldEnumOption> {
    const field = await verifyFieldOwnership(customFieldId, organizationId);
    const isRename = input.name !== undefined;

    const updated = await withDb.tx(async (tx) => {
      const option = await tx.customFieldEnumOption.update({
        where: { id: optionId, customFieldId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.color === undefined ? {} : { color: input.color }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        },
      });

      // `CustomFieldValue.organizationId` is its own column, not derived from
      // the field's, so a mismatched row is schema-valid and only the explicit
      // org predicate keeps these rewrites inside the tenant.
      if (isRename && field.fieldType === CustomFieldType.Enum) {
        // An ENUM row's displayValue is the option name verbatim, so every
        // affected row takes the same string.
        await tx.customFieldValue.updateMany({
          where: { customFieldId, organizationId, enumValueId: optionId },
          data: { displayValue: option.name },
        });
      }

      // A MULTI_ENUM row joins the names of every option it selected, so the
      // string differs per row — but Postgres can re-derive them all at once.
      if (isRename && field.fieldType === CustomFieldType.MultiEnum) {
        await updateMultiEnumDisplayValues(
          tx,
          customFieldId,
          organizationId,
          optionId
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

    const uniqueIds = new Set(orderedOptionIds);
    if (uniqueIds.size !== orderedOptionIds.length) {
      throw new Error("Duplicate option IDs are not allowed in reorder list.");
    }

    if (orderedOptionIds.length !== field.enumOptions.length) {
      throw new Error(
        `Expected ${field.enumOptions.length} option IDs but received ${orderedOptionIds.length}. All options must be included in the reorder list.`
      );
    }

    // Nothing to reorder (a field with no options) — skip the batched UPDATE so
    // we never emit an empty `VALUES ()` clause. Mirrors the no-op the previous
    // `Promise.all([])` produced, and projectsService.reorder's empty guard.
    if (orderedOptionIds.length === 0) {
      return;
    }

    await withDb.tx(async (tx) => {
      const valueRows = orderedOptionIds.map(
        (optionId, index) => Prisma.sql`(${optionId}::uuid, ${index}::int)`
      );
      await tx.$executeRaw(Prisma.sql`
        UPDATE "custom_field_enum_options"
        SET "sort_order" = data.new_order
        FROM (VALUES ${Prisma.join(valueRows)}) AS data(id, new_order)
        WHERE "custom_field_enum_options"."id" = data.id
          AND "custom_field_enum_options"."custom_field_id" = ${customFieldId}::uuid
      `);
    });
  },
};

/**
 * Re-derives `display_value` for every MULTI_ENUM value row that selected the
 * given option, in one statement.
 *
 * Mirrors `computeDisplayValue`'s MULTI_ENUM arm: the selected options' names in
 * `multi_enum_value_ids` order, ids with no surviving option on the field
 * dropped, joined by MULTI_ENUM_DISPLAY_SEPARATOR. It reads `name` from the
 * table, so it must run after the rename write in the same transaction.
 *
 * `multi_enum_value_ids` is `text[]` while option ids are `uuid`, hence the
 * `::text` on the join — casting the other direction would error on a stored id
 * that is not a well-formed uuid.
 */
function updateMultiEnumDisplayValues(
  tx: TransactionClient,
  customFieldId: string,
  organizationId: string,
  optionId: string
): Promise<number> {
  // `now()` is the transaction's start time, so it can land *behind* a row
  // written later in that same transaction. Prisma stamps `@updatedAt` from the
  // client clock, so taking the value from the same clock here keeps this write
  // monotonic against the ENUM arm and against any Prisma write that preceded
  // it in this transaction.
  const updatedAt = new Date();
  return tx.$executeRaw(Prisma.sql`
    UPDATE "custom_field_values" AS cfv
    SET "display_value" = COALESCE(
          (
            SELECT string_agg(
                     opt."name",
                     ${MULTI_ENUM_DISPLAY_SEPARATOR}::text
                     ORDER BY selected.ordinality
                   )
            FROM unnest(cfv."multi_enum_value_ids")
                 WITH ORDINALITY AS selected(option_id, ordinality)
            JOIN "custom_field_enum_options" AS opt
              ON opt."id"::text = selected.option_id
             AND opt."custom_field_id" = cfv."custom_field_id"
          ),
          ''
        ),
        -- timestamp WITHOUT time zone holding UTC, matching what Prisma writes.
        "updated_at" = ${updatedAt}::timestamp
    WHERE cfv."custom_field_id" = ${customFieldId}::uuid
      AND cfv."organization_id" = ${organizationId}::uuid
      AND cfv."multi_enum_value_ids" && ARRAY[${optionId}]::text[]
  `);
}
