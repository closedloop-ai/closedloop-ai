import type {
  AttachCustomFieldInput,
  CustomFieldSettingWithOptions,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
  LabelPosition,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { DocumentType } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import { computeDisplayValue, validateValueType } from "./utils";

/**
 * Thrown when the target entity is not found or does not belong to the organization.
 * Caught by the route layer to return a 404 response.
 */
export class EntityNotFoundError extends Error {
  constructor(entityType: string, entityId: string) {
    super(`${entityType} with id "${entityId}" not found.`);
    this.name = "EntityNotFoundError";
  }
}

/**
 * Thrown when the custom field does not belong to the organization.
 * Caught by the route layer to return a 404 response.
 */
export class FieldNotFoundError extends Error {
  constructor(fieldId: string) {
    super(`Custom field with id "${fieldId}" not found.`);
    this.name = "FieldNotFoundError";
  }
}

/**
 * Custom field values service - handles database operations for field settings and values.
 *
 * Settings methods (attach, detach, list) are implemented here.
 * Value read/write methods will be added in a subsequent task (T-3.3).
 *
 * No auth checks here — those belong in the route layer.
 */
export const customFieldValuesService = {
  /**
   * Attach a custom field to an entity by creating a CustomFieldSetting.
   *
   * For PROJECT entities, also cascades the setting to all direct child
   * Workstreams and Features within the same transaction.
   *
   * Verifies:
   * - The entity exists and belongs to the organization.
   * - The custom field belongs to the organization.
   *
   * @throws EntityNotFoundError if the entity is not found.
   * @throws FieldNotFoundError if the field is not found in this org.
   */
  async attachField(
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string,
    input: AttachCustomFieldInput
  ): Promise<CustomFieldSettingWithOptions> {
    await verifyEntityExists(entityType, entityId, organizationId);
    await verifyFieldBelongsToOrg(fieldId, organizationId);

    const settingData = {
      customFieldId: fieldId,
      organizationId,
      entityType,
      entityId,
      isImportant: input.isImportant ?? false,
      isRequired: input.isRequired ?? false,
      sortOrder: input.sortOrder ?? 0,
    };

    const setting = await withDb.tx(async (tx) => {
      const created = await tx.customFieldSetting.create({
        data: settingData,
        include: SETTING_WITH_FIELD_INCLUDE,
      });

      if (entityType === CustomFieldEntityType.Project) {
        await cascadeProjectFieldToChildren(tx, {
          fieldId,
          organizationId,
          projectId: entityId,
          input,
        });
      }

      return created;
    });

    return toSettingWithOptions(setting);
  },

  /**
   * Detach a custom field from an entity by deleting its CustomFieldSetting.
   *
   * Verifies the entity exists and belongs to the organization before deleting.
   *
   * @throws EntityNotFoundError if the entity is not found.
   */
  async detachField(
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string
  ): Promise<void> {
    await verifyEntityExists(entityType, entityId, organizationId);

    await withDb((db) =>
      db.customFieldSetting.deleteMany({
        where: { customFieldId: fieldId, entityType, entityId, organizationId },
      })
    );
  },

  /**
   * List all custom field settings for a specific entity instance.
   * Filtered by entityType, entityId, and organizationId.
   * Ordered by sortOrder ascending.
   */
  listSettings(
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string
  ): Promise<CustomFieldSettingWithOptions[]> {
    return withDb(async (db) => {
      const settings = await db.customFieldSetting.findMany({
        where: { entityType, entityId, organizationId },
        include: SETTING_WITH_FIELD_INCLUDE,
        orderBy: { sortOrder: "asc" },
      });
      return settings.map(toSettingWithOptions);
    });
  },

  /**
   * Get all custom field values for one entity or a batch of entities.
   *
   * Single entity: pass a string entityId.
   * Batch: pass an array of entityIds — the query uses `entityId: { in: entityIds }`.
   * Both variants include the resolved enumValue relation.
   *
   * Note: peopleValues are not resolved here — callers use setValueForEntity
   * which pre-computes displayValue. Use the raw peopleValueIds if needed.
   */
  getValuesForEntity(
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string | string[],
    organizationId: string
  ): Promise<CustomFieldValueDetail[]> {
    return withDb(async (db) => {
      const whereEntityId = Array.isArray(entityId)
        ? { in: entityId }
        : entityId;

      const rows = await db.customFieldValue.findMany({
        where: { entityType, entityId: whereEntityId, organizationId },
        include: VALUE_WITH_ENUM_INCLUDE,
      });

      // For PEOPLE fields, we need user records to build BasicUser[].
      // Collect all unique people IDs across all rows and batch-fetch.
      const allPeopleIds = [
        ...new Set(rows.flatMap((row) => row.peopleValueIds)),
      ];

      const peopleMap = new Map<string, BasicUser>();
      if (allPeopleIds.length > 0) {
        const users = await db.user.findMany({
          where: { id: { in: allPeopleIds }, organizationId },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        });
        for (const u of users) {
          peopleMap.set(u.id, u);
        }
      }

      return rows.map((row) => toValueDetail(row, peopleMap));
    });
  },

  /**
   * Set (upsert) a custom field value for a specific entity instance.
   *
   * Validation steps:
   * 1. Verify entity exists and belongs to the organization.
   * 2. Verify field belongs to the organization (and load it with enum options).
   * 3. For ENUM fields: verify the option exists and is enabled.
   * 4. For MULTI_ENUM fields: verify each option exists and is enabled.
   * 5. For PEOPLE fields: verify all user IDs belong to the organization.
   * 6. Compute the displayValue string.
   * 7. Upsert the CustomFieldValue row.
   *
   * @throws EntityNotFoundError if the entity is not found.
   * @throws FieldNotFoundError if the field is not found in this org.
   * @throws Error for invalid enum option IDs, disabled options, or unknown user IDs.
   */
  async setValueForEntity(
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string,
    rawValue: string | number | string[] | null
  ): Promise<CustomFieldValueDetail> {
    await verifyEntityExists(entityType, entityId, organizationId);

    const field = await withDb((db) =>
      db.customField.findFirst({
        where: { id: fieldId, organizationId },
        include: { enumOptions: { orderBy: { sortOrder: "asc" } } },
      })
    );

    if (!field) {
      throw new FieldNotFoundError(fieldId);
    }

    validateValueType(
      field.fieldType as (typeof CustomFieldType)[keyof typeof CustomFieldType],
      rawValue
    );

    const valuePayload = await buildValuePayload(
      field.fieldType,
      fieldId,
      organizationId,
      rawValue
    );

    const fieldWithOptions = toFieldWithOptions(field);
    const displayValue = await computeDisplayValue(fieldWithOptions, rawValue);

    const upsertData = { ...valuePayload, displayValue };

    const upserted = await withDb((db) =>
      db.customFieldValue.upsert({
        where: {
          customFieldId_entityType_entityId: {
            customFieldId: fieldId,
            entityType,
            entityId,
          },
        },
        create: {
          customFieldId: fieldId,
          organizationId,
          entityType,
          entityId,
          ...upsertData,
        },
        update: upsertData,
        include: VALUE_WITH_ENUM_INCLUDE,
      })
    );

    const peopleMap = await resolvePeopleMap(
      upserted.peopleValueIds,
      organizationId
    );
    return toValueDetail(upserted, peopleMap);
  },

  /**
   * Clear (delete) a custom field value for a specific entity instance.
   * Uses deleteMany so it is a no-op if no value exists.
   */
  clearValue(
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string
  ): Promise<void> {
    return withDb(async (db) => {
      await db.customFieldValue.deleteMany({
        where: {
          customFieldId: fieldId,
          entityType,
          entityId,
          organizationId,
        },
      });
    });
  },
};

/**
 * Verifies that an entity exists and belongs to the given organization.
 * Throws EntityNotFoundError if not found.
 */
async function verifyEntityExists(
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  entityId: string,
  organizationId: string
): Promise<void> {
  const exists = await withDb(async (db) => {
    switch (entityType) {
      case CustomFieldEntityType.Project: {
        const record = await db.project.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        });
        return record !== null;
      }
      case CustomFieldEntityType.Workstream: {
        const record = await db.workstream.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        });
        return record !== null;
      }
      case CustomFieldEntityType.Document: {
        const record = await db.document.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        });
        return record !== null;
      }
      default: {
        throw new Error(
          `Unsupported entity type: ${entityType satisfies never}.`
        );
      }
    }
  });

  if (!exists) {
    throw new EntityNotFoundError(entityType, entityId);
  }
}

/**
 * Verifies that a custom field belongs to the given organization.
 * Throws FieldNotFoundError if not found.
 */
async function verifyFieldBelongsToOrg(
  fieldId: string,
  organizationId: string
): Promise<void> {
  const field = await withDb((db) =>
    db.customField.findFirst({
      where: { id: fieldId, organizationId },
      select: { id: true },
    })
  );

  if (!field) {
    throw new FieldNotFoundError(fieldId);
  }
}

/**
 * Standard include for CustomFieldValue queries.
 * Includes the enumValue relation and the customField definition with enum options
 * (for name/fieldType denorm and multiEnumValues resolution).
 * peopleValueIds are raw ID arrays — callers resolve them separately.
 */
const VALUE_WITH_ENUM_INCLUDE = {
  enumValue: true,
  customField: {
    include: {
      enumOptions: { orderBy: { sortOrder: "asc" as const } },
    },
  },
} as const;

/** Type for a CustomFieldValue row returned with the enumValue and customField relations included. */
type ValueFromDb = Prisma.CustomFieldValueGetPayload<{
  include: typeof VALUE_WITH_ENUM_INCLUDE;
}>;

/**
 * Column payload shape used when building the upsert create/update data.
 * Only one value column should be populated per write; the rest remain null/[].
 */
type ValueColumnPayload = {
  textValue: string | null;
  numberValue: number | null;
  dateValue: Date | null;
  enumValueId: string | null;
  multiEnumValueIds: string[];
  peopleValueIds: string[];
};

/** Returns a zeroed ValueColumnPayload (all nullable columns null, arrays empty). */
function buildEmptyPayload(): ValueColumnPayload {
  return {
    textValue: null,
    numberValue: null,
    dateValue: null,
    enumValueId: null,
    multiEnumValueIds: [],
    peopleValueIds: [],
  };
}

/**
 * Prisma type for a custom field with enum options — used inside setValueForEntity
 * to avoid repeating the inline query type.
 */
type FieldWithEnumOptions = Prisma.CustomFieldGetPayload<{
  include: { enumOptions: true };
}>;

/**
 * Validates and builds the typed column payload for a field write.
 * Dispatches to type-specific helpers to keep cognitive complexity low.
 */
async function buildValuePayload(
  fieldType: string,
  fieldId: string,
  organizationId: string,
  rawValue: string | number | string[] | null
): Promise<ValueColumnPayload> {
  const payload = buildEmptyPayload();
  if (rawValue === null || rawValue === undefined) {
    return payload;
  }
  if (fieldType === CustomFieldType.Enum) {
    payload.enumValueId = await validateEnumOptionExists(
      fieldId,
      String(rawValue)
    );
  } else if (fieldType === CustomFieldType.MultiEnum) {
    payload.multiEnumValueIds = await validateMultiEnumOptions(
      fieldId,
      rawValue
    );
  } else if (fieldType === CustomFieldType.People) {
    payload.peopleValueIds = await validatePeopleIds(organizationId, rawValue);
  } else if (fieldType === CustomFieldType.Text) {
    payload.textValue = String(rawValue);
  } else if (fieldType === CustomFieldType.Number) {
    payload.numberValue = Number(rawValue);
  } else if (fieldType === CustomFieldType.Date) {
    payload.dateValue = new Date(String(rawValue));
  }
  return payload;
}

/**
 * Validates a single enum option ID exists for the field and is enabled.
 * Returns the option ID on success.
 */
async function validateEnumOptionExists(
  fieldId: string,
  optionId: string
): Promise<string> {
  const option = await withDb((db) =>
    db.customFieldEnumOption.findFirst({
      where: { id: optionId, customFieldId: fieldId },
    })
  );
  if (!option) {
    throw new Error(
      `Enum option "${optionId}" not found for field "${fieldId}".`
    );
  }
  if (!option.enabled) {
    throw new Error(`Enum option "${optionId}" is disabled and cannot be set.`);
  }
  return optionId;
}

/**
 * Validates each option ID in a MULTI_ENUM value exists and is enabled.
 * Uses a single batch query instead of sequential lookups.
 * Returns the validated array.
 */
async function validateMultiEnumOptions(
  fieldId: string,
  rawValue: string | number | string[]
): Promise<string[]> {
  const optionIds = Array.isArray(rawValue)
    ? (rawValue as string[])
    : [String(rawValue)];

  const options = await withDb((db) =>
    db.customFieldEnumOption.findMany({
      where: { id: { in: optionIds }, customFieldId: fieldId },
    })
  );

  if (options.length !== optionIds.length) {
    const foundIds = new Set(options.map((o) => o.id));
    const missing = optionIds.filter((id) => !foundIds.has(id));
    throw new Error(
      `Enum option(s) "${missing.join(", ")}" not found for field "${fieldId}".`
    );
  }

  const disabledOption = options.find((o) => !o.enabled);
  if (disabledOption) {
    throw new Error(
      `Enum option "${disabledOption.id}" is disabled and cannot be set.`
    );
  }

  return optionIds;
}

/**
 * Validates that all user IDs in a PEOPLE value belong to the organization.
 * Returns the validated array.
 */
async function validatePeopleIds(
  organizationId: string,
  rawValue: string | number | string[]
): Promise<string[]> {
  const userIds = Array.isArray(rawValue)
    ? (rawValue as string[])
    : [String(rawValue)];
  const users = await withDb((db) =>
    db.user.findMany({
      where: { id: { in: userIds }, organizationId },
      select: { id: true },
    })
  );
  if (users.length !== userIds.length) {
    throw new Error(
      "One or more user IDs are invalid or do not belong to this organization."
    );
  }
  return userIds;
}

/**
 * Maps a Prisma CustomField+enumOptions record to the CustomFieldWithOptions API shape.
 * Used to call computeDisplayValue without duplicating the mapping logic.
 */
function toFieldWithOptions(
  field: FieldWithEnumOptions
): CustomFieldWithOptions {
  return {
    id: field.id,
    organizationId: field.organizationId,
    name: field.name,
    description: field.description,
    fieldType:
      field.fieldType as (typeof CustomFieldType)[keyof typeof CustomFieldType],
    createdById: field.createdById,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
    precision: field.precision,
    numberFormat: field.numberFormat as NumberFormat | null,
    currencyCode: field.currencyCode,
    customLabel: field.customLabel,
    customLabelPosition: field.customLabelPosition as LabelPosition | null,
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

/**
 * Batch-fetches users by ID and returns a Map<userId, BasicUser>.
 * Returns an empty map when ids is empty.
 */
async function resolvePeopleMap(
  ids: string[],
  organizationId: string
): Promise<Map<string, BasicUser>> {
  const map = new Map<string, BasicUser>();
  if (ids.length === 0) {
    return map;
  }
  const users = await withDb((db) =>
    db.user.findMany({
      where: { id: { in: ids }, organizationId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    })
  );
  for (const u of users) {
    map.set(u.id, u);
  }
  return map;
}

/**
 * Standard include for CustomFieldSetting queries that include the field with its options.
 */
const SETTING_WITH_FIELD_INCLUDE = {
  customField: {
    include: {
      enumOptions: {
        orderBy: { sortOrder: "asc" as const },
      },
    },
  },
} as const;

/** Type for a setting returned from the database with field and options included. */
type SettingFromDb = Prisma.CustomFieldSettingGetPayload<{
  include: typeof SETTING_WITH_FIELD_INCLUDE;
}>;

/**
 * Transform a Prisma CustomFieldSetting record into the API CustomFieldSettingWithOptions shape.
 */
function toSettingWithOptions(
  setting: SettingFromDb
): CustomFieldSettingWithOptions {
  return {
    id: setting.id,
    customFieldId: setting.customFieldId,
    entityType: setting.entityType,
    entityId: setting.entityId,
    isImportant: setting.isImportant,
    isRequired: setting.isRequired,
    sortOrder: setting.sortOrder,
    createdAt: setting.createdAt,
    customField: {
      id: setting.customField.id,
      organizationId: setting.customField.organizationId,
      name: setting.customField.name,
      description: setting.customField.description,
      fieldType: setting.customField.fieldType,
      createdById: setting.customField.createdById,
      createdAt: setting.customField.createdAt,
      updatedAt: setting.customField.updatedAt,
      precision: setting.customField.precision,
      numberFormat: setting.customField.numberFormat,
      currencyCode: setting.customField.currencyCode,
      customLabel: setting.customField.customLabel,
      customLabelPosition: setting.customField.customLabelPosition,
      isGlobalToOrg: setting.customField.isGlobalToOrg,
      entityTypes: setting.customField.entityTypes,
      showInTable: setting.customField.showInTable,
      isSearchable: setting.customField.isSearchable,
      isSortable: setting.customField.isSortable,
      enumOptions: setting.customField.enumOptions.map((opt) => ({
        id: opt.id,
        customFieldId: opt.customFieldId,
        name: opt.name,
        color: opt.color,
        enabled: opt.enabled,
        sortOrder: opt.sortOrder,
      })),
    },
  };
}

/**
 * Transform a Prisma CustomFieldValue row (with enumValue and customField+enumOptions included)
 * into the API CustomFieldValueDetail shape.
 *
 * multiEnumValues are resolved by filtering the customField's enumOptions using
 * the row's multiEnumValueIds array.
 *
 * @param row - The database row with enumValue and customField relations included.
 * @param peopleMap - Pre-fetched user records keyed by user ID (for PEOPLE fields).
 */
function toValueDetail(
  row: ValueFromDb,
  peopleMap: Map<string, BasicUser>
): CustomFieldValueDetail {
  const enumValue =
    row.enumValue !== null
      ? {
          id: row.enumValue.id,
          customFieldId: row.enumValue.customFieldId,
          name: row.enumValue.name,
          color: row.enumValue.color,
          enabled: row.enumValue.enabled,
          sortOrder: row.enumValue.sortOrder,
        }
      : null;

  const peopleValues: BasicUser[] = row.peopleValueIds
    .map((id) => peopleMap.get(id))
    .filter((u): u is BasicUser => u !== undefined);

  // Resolve multiEnumValues from the customField's enumOptions
  const multiEnumIdSet = new Set(row.multiEnumValueIds);
  const multiEnumValues = row.customField.enumOptions
    .filter((opt) => multiEnumIdSet.has(opt.id))
    .map((opt) => ({
      id: opt.id,
      customFieldId: opt.customFieldId,
      name: opt.name,
      color: opt.color,
      enabled: opt.enabled,
      sortOrder: opt.sortOrder,
    }));

  return {
    id: row.id,
    customFieldId: row.customFieldId,
    entityId: row.entityId,
    name: row.customField.name,
    fieldType: row.customField
      .fieldType as (typeof CustomFieldType)[keyof typeof CustomFieldType],
    displayValue: row.displayValue ?? null,
    showInTable: row.customField.showInTable,
    textValue: row.textValue ?? null,
    numberValue: row.numberValue ?? null,
    dateValue: row.dateValue ?? null,
    enumValue,
    multiEnumValues,
    peopleValues,
  };
}

type CascadeInput = {
  fieldId: string;
  organizationId: string;
  projectId: string;
  input: AttachCustomFieldInput;
};

async function cascadeProjectFieldToChildren(
  tx: Prisma.TransactionClient,
  { fieldId, organizationId, projectId, input }: CascadeInput
): Promise<void> {
  // Features are feature-typed documents — cascade only against the document
  // table. The legacy `issues` table still exists during the migration window
  // but holds the same UUIDs, so querying it would create duplicate settings
  // (skipDuplicates can't help because the entityType differs).
  const [childWorkstreams, childFeatureDocuments] = await Promise.all([
    tx.workstream.findMany({
      where: { projectId, organizationId },
      select: { id: true },
    }),
    tx.document.findMany({
      where: { projectId, organizationId, type: DocumentType.Feature },
      select: { id: true },
    }),
  ]);

  const defaults = {
    customFieldId: fieldId,
    organizationId,
    isImportant: input.isImportant ?? false,
    isRequired: input.isRequired ?? false,
    sortOrder: input.sortOrder ?? 0,
  };

  const childSettingsData: Prisma.CustomFieldSettingCreateManyInput[] = [
    ...childWorkstreams.map((ws) => ({
      ...defaults,
      entityType: CustomFieldEntityType.Workstream,
      entityId: ws.id,
    })),
    ...childFeatureDocuments.map((doc) => ({
      ...defaults,
      entityType: CustomFieldEntityType.Document,
      entityId: doc.id,
    })),
  ];

  if (childSettingsData.length > 0) {
    await tx.customFieldSetting.createMany({
      data: childSettingsData,
      skipDuplicates: true,
    });
  }
}
