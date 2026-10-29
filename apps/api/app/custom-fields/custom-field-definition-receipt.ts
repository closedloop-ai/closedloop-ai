import type {
  CustomField as PrismaCustomField,
  CustomFieldEnumOption as PrismaCustomFieldEnumOption,
} from "@repo/database";

/**
 * ISS-12552: the custom field columns `PUT /custom-fields/[id]` can write, for
 * its receipt's `changedFields`. Every entry must be a column, so a renamed one
 * fails `tsc` here instead of silently dropping out of the diff.
 */
export const CUSTOM_FIELD_UPDATE_FIELDS = [
  "name",
  "description",
  "precision",
  "numberFormat",
  "currencyCode",
  "customLabel",
  "customLabelPosition",
  "entityTypes",
  "referenceTargetSources",
  "showInTable",
  "isSearchable",
  "isSortable",
] as const satisfies readonly (keyof PrismaCustomField)[];

/** Reads those columns, plus `fieldType`, which the update validates against. */
export const CUSTOM_FIELD_UPDATE_SELECT = {
  name: true,
  description: true,
  precision: true,
  numberFormat: true,
  currencyCode: true,
  customLabel: true,
  customLabelPosition: true,
  entityTypes: true,
  referenceTargetSources: true,
  showInTable: true,
  isSearchable: true,
  isSortable: true,
  fieldType: true,
} as const satisfies Record<
  (typeof CUSTOM_FIELD_UPDATE_FIELDS)[number] | "fieldType",
  true
>;

/** The enum option columns `PUT .../enum-options/[optionId]` can write. */
export const ENUM_OPTION_UPDATE_FIELDS = [
  "name",
  "color",
  "enabled",
] as const satisfies readonly (keyof PrismaCustomFieldEnumOption)[];
