import type {
  CreateCustomFieldInput,
  CustomFieldWithOptions,
  UpdateCustomFieldInput,
} from "@repo/api/src/types/custom-field";
import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  MAX_CUSTOM_FIELDS_PER_ORG,
  validateFieldNameNotReserved,
} from "./utils";

/**
 * Thrown when a custom field with the same name already exists in the organization.
 * Caught by the route layer to return a 409 conflict response.
 */
export class DuplicateNameError extends Error {
  constructor(name: string) {
    super(
      `A custom field named "${name}" already exists in this organization.`
    );
    this.name = "DuplicateNameError";
  }
}

/**
 * Custom fields service - handles database operations for custom field definitions.
 * No auth checks here — those belong in the route layer.
 */
export const customFieldsService = {
  /**
   * Create a new custom field definition.
   * Checks the 500-field org limit inside the creation transaction to avoid TOCTOU.
   * Throws DuplicateNameError on unique name violation (P2002).
   * Creates enum options inline within the same transaction.
   */
  async createField(
    organizationId: string,
    userId: string,
    input: CreateCustomFieldInput
  ): Promise<CustomFieldWithOptions> {
    const { enumOptions, ...fieldData } = input;

    // Validate name doesn't conflict with built-in entity properties
    if (input.entityTypes && input.entityTypes.length > 0) {
      validateFieldNameNotReserved(input.name, input.entityTypes);
    }

    try {
      const field = await withDb.tx(async (tx) => {
        // Check field limit inside the transaction to avoid TOCTOU race
        const count = await tx.customField.count({
          where: { organizationId },
        });
        if (count >= MAX_CUSTOM_FIELDS_PER_ORG) {
          throw new Error(
            `Organization has reached the maximum of ${MAX_CUSTOM_FIELDS_PER_ORG} custom field definitions.`
          );
        }

        const created = await tx.customField.create({
          data: {
            ...fieldData,
            organizationId,
            createdById: userId,
            ...(enumOptions && enumOptions.length > 0
              ? {
                  enumOptions: {
                    create: enumOptions.map((opt, index) => ({
                      name: opt.name,
                      color: opt.color ?? "none",
                      enabled: opt.enabled ?? true,
                      sortOrder: opt.sortOrder ?? index,
                    })),
                  },
                }
              : {}),
          },
          include: CUSTOM_FIELD_WITH_OPTIONS_INCLUDE,
        });

        return created;
      });

      return toCustomField(field);
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        throw new DuplicateNameError(input.name);
      }
      throw error;
    }
  },

  /**
   * Find all custom field definitions for an organization.
   * Includes enum options ordered by sortOrder.
   */
  async findByOrg(organizationId: string): Promise<CustomFieldWithOptions[]> {
    const fields = await withDb((db) =>
      db.customField.findMany({
        where: { organizationId },
        include: CUSTOM_FIELD_WITH_OPTIONS_INCLUDE,
        orderBy: { createdAt: "asc" },
      })
    );
    return fields.map(toCustomField);
  },

  /**
   * Find a custom field by ID, scoped to the organization.
   * Returns null if not found or if the field belongs to a different org.
   */
  async findById(
    id: string,
    organizationId: string
  ): Promise<CustomFieldWithOptions | null> {
    const field = await withDb((db) =>
      db.customField.findFirst({
        where: { id, organizationId },
        include: CUSTOM_FIELD_WITH_OPTIONS_INCLUDE,
      })
    );
    return field ? toCustomField(field) : null;
  },

  /**
   * Update a custom field's mutable fields.
   * fieldType is immutable after creation — UpdateCustomFieldInput excludes it.
   */
  async updateField(
    id: string,
    organizationId: string,
    input: Omit<UpdateCustomFieldInput, "id">
  ): Promise<CustomFieldWithOptions> {
    try {
      const field = await withDb.tx(async (tx) => {
        // Validate name doesn't conflict with built-in entity properties.
        // Read + validate + update inside a single transaction to prevent TOCTOU race.
        if (input.name || input.entityTypes) {
          const existing = await tx.customField.findFirst({
            where: { id, organizationId },
            select: { name: true, entityTypes: true },
          });
          if (existing) {
            const nameToCheck = input.name ?? existing.name;
            const typesToCheck = input.entityTypes ?? existing.entityTypes;
            validateFieldNameNotReserved(nameToCheck, typesToCheck);
          }
        }

        return tx.customField.update({
          where: { id, organizationId },
          data: {
            name: input.name,
            description: input.description,
            precision: input.precision,
            numberFormat: input.numberFormat,
            currencyCode: input.currencyCode,
            customLabel: input.customLabel,
            customLabelPosition: input.customLabelPosition,
            entityTypes: input.entityTypes,
            showInTable: input.showInTable,
            isSearchable: input.isSearchable,
            isSortable: input.isSortable,
          },
          include: CUSTOM_FIELD_WITH_OPTIONS_INCLUDE,
        });
      });
      return toCustomField(field);
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        throw new DuplicateNameError(input.name ?? "");
      }
      throw error;
    }
  },

  /**
   * Delete a custom field and all dependent records.
   * Explicit cascade order required since relationMode=prisma has no DB-level cascade.
   * Order: CustomFieldValue → CustomFieldSetting → CustomFieldEnumOption → CustomField
   */
  deleteField(id: string, organizationId: string): Promise<void> {
    return withDb.tx(async (tx) => {
      await tx.customFieldValue.deleteMany({ where: { customFieldId: id } });
      await tx.customFieldSetting.deleteMany({ where: { customFieldId: id } });
      await tx.customFieldEnumOption.deleteMany({
        where: { customFieldId: id },
      });
      await tx.customField.delete({ where: { id, organizationId } });
    });
  },
};

/**
 * Standard include for custom field queries that include enum options.
 * Enum options ordered by sortOrder ascending.
 */
const CUSTOM_FIELD_WITH_OPTIONS_INCLUDE = {
  enumOptions: {
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

/** Type for a custom field returned from database with enum options included. */
type CustomFieldFromDb = Prisma.CustomFieldGetPayload<{
  include: typeof CUSTOM_FIELD_WITH_OPTIONS_INCLUDE;
}>;

/**
 * Transform a Prisma custom field record into the API CustomFieldWithOptions shape.
 * Follows the toProjectWithDetails pattern from projects/service.ts.
 */
function toCustomField(field: CustomFieldFromDb): CustomFieldWithOptions {
  return {
    id: field.id,
    organizationId: field.organizationId,
    name: field.name,
    description: field.description,
    fieldType: field.fieldType,
    createdById: field.createdById,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
    precision: field.precision,
    numberFormat: field.numberFormat,
    currencyCode: field.currencyCode,
    customLabel: field.customLabel,
    customLabelPosition: field.customLabelPosition,
    isGlobalToOrg: field.isGlobalToOrg,
    entityTypes: field.entityTypes,
    showInTable: field.showInTable,
    isSearchable: field.isSearchable,
    isSortable: field.isSortable,
    enumOptions: field.enumOptions.map((opt) => ({
      id: opt.id,
      customFieldId: opt.customFieldId,
      name: opt.name,
      color: opt.color,
      enabled: opt.enabled,
      sortOrder: opt.sortOrder,
    })),
  };
}
