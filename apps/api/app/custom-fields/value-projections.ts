import type {
  CustomFieldSettingWithOptions,
  CustomFieldType,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import type { Prisma } from "@repo/database";
import { orderRowsByIdFrom } from "@/lib/order-rows-by";
import { resolveDisplayValue } from "./display-value";
import {
  REFERENCE_TARGETS_INCLUDE,
  toReferenceTargets,
} from "./reference-targets";

/**
 * Query includes and row -> API projections for custom field values and settings.
 *
 * Split out of `values-service.ts` (ISS-7208) to keep that module under the
 * file-size ceiling: the service owns reads and writes, this owns the shape
 * those reads return.
 */

/**
 * Standard include for CustomFieldValue queries.
 * Includes the enumValue relation and the customField definition with enum options
 * (for name/fieldType denorm and multiEnumValues resolution).
 * peopleValueIds are raw ID arrays — callers resolve them separately and pass
 * the result to `toValueDetail`, which both projects it and derives the PEOPLE
 * display string from it (PEOPLE is `ResolvedOnRead`).
 */
export const VALUE_WITH_ENUM_INCLUDE = {
  enumValue: true,
  customField: {
    include: {
      enumOptions: { orderBy: { sortOrder: "asc" as const } },
    },
  },
  references: REFERENCE_TARGETS_INCLUDE,
} as const;

/** Type for a CustomFieldValue row returned with the enumValue and customField relations included. */
export type ValueFromDb = Prisma.CustomFieldValueGetPayload<{
  include: typeof VALUE_WITH_ENUM_INCLUDE;
}>;

/**
 * Standard include for CustomFieldSetting queries that include the field with its options.
 */
export const SETTING_WITH_FIELD_INCLUDE = {
  customField: {
    include: {
      enumOptions: {
        orderBy: { sortOrder: "asc" as const },
      },
    },
  },
} as const;

/** Type for a setting returned from the database with field and options included. */
export type SettingFromDb = Prisma.CustomFieldSettingGetPayload<{
  include: typeof SETTING_WITH_FIELD_INCLUDE;
}>;

/**
 * Transform a Prisma CustomFieldSetting record into the API CustomFieldSettingWithOptions shape.
 */
export function toSettingWithOptions(
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
      referenceTargetSources: setting.customField.referenceTargetSources,
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
export function toValueDetail(
  row: ValueFromDb,
  peopleMap: Map<string, BasicUser>
): CustomFieldValueDetail {
  const enumValue =
    row.enumValue === null
      ? null
      : {
          id: row.enumValue.id,
          customFieldId: row.enumValue.customFieldId,
          name: row.enumValue.name,
          color: row.enumValue.color,
          enabled: row.enumValue.enabled,
          sortOrder: row.enumValue.sortOrder,
        };

  // ONE ordering, reused below: `peopleValues` and the derived `displayValue`
  // must name the same users in the same sequence, so they come from the same
  // array rather than two look-alike derivations (ISS-7215). Indexed off the
  // map rather than a spread of it — `getValuesForEntity` resolves one map for
  // the whole page and calls this per row.
  const peopleValues: BasicUser[] = orderRowsByIdFrom(
    peopleMap,
    row.peopleValueIds
  );

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

  const fieldType = row.customField
    .fieldType as (typeof CustomFieldType)[keyof typeof CustomFieldType];

  const referenceValues = toReferenceTargets(
    row.references.map((ref) => ref.targetArtifact)
  );

  return {
    id: row.id,
    customFieldId: row.customFieldId,
    entityId: row.entityId,
    name: row.customField.name,
    fieldType,
    displayValue: resolveDisplayValue(
      fieldType,
      row.displayValue ?? null,
      referenceValues,
      peopleValues
    ),
    showInTable: row.customField.showInTable,
    textValue: row.textValue ?? null,
    numberValue: row.numberValue ?? null,
    dateValue: row.dateValue ?? null,
    enumValue,
    multiEnumValues,
    peopleValues,
    referenceValues,
  };
}
