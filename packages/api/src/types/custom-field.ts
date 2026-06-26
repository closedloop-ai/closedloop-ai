// Custom Field types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { BasicUser } from "./user.js";

/**
 * The types of values a custom field can hold.
 * Mirrors the Prisma CustomFieldType enum.
 */
export const CustomFieldType = {
  Text: "TEXT",
  Number: "NUMBER",
  Enum: "ENUM",
  MultiEnum: "MULTI_ENUM",
  Date: "DATE",
  People: "PEOPLE",
} as const;
export type CustomFieldType =
  (typeof CustomFieldType)[keyof typeof CustomFieldType];

/**
 * The entity types that custom fields can be attached to.
 *
 * NOTE: This is intentionally distinct from `EntityType` in `entity-link.ts`.
 * `EntityType` (DOCUMENT, EXTERNAL_LINK) models polymorphic *link* relationships
 * between entities. `CustomFieldEntityType` models which domain entities can have custom
 * field definitions attached — it includes PROJECT (which is not a link target)
 * and omits EXTERNAL_LINK (which cannot hold custom field values).
 */
export const CustomFieldEntityType = {
  Project: "PROJECT",
  Document: "DOCUMENT",
} as const;
export type CustomFieldEntityType =
  (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType];

/**
 * Display format for NUMBER type custom fields.
 * Mirrors the Prisma NumberFormat enum.
 */
export const NumberFormat = {
  None: "NONE",
  Currency: "CURRENCY",
  Percentage: "PERCENTAGE",
  Custom: "CUSTOM",
} as const;
export type NumberFormat = (typeof NumberFormat)[keyof typeof NumberFormat];

/**
 * Position of a custom label relative to the number value for CUSTOM number format.
 * Mirrors the Prisma LabelPosition enum.
 */
export const LabelPosition = {
  Prefix: "PREFIX",
  Suffix: "SUFFIX",
} as const;
export type LabelPosition = (typeof LabelPosition)[keyof typeof LabelPosition];

// Enum option types

export type CustomFieldEnumOption = {
  id: string;
  customFieldId: string;
  name: string;
  color: string;
  enabled: boolean;
  sortOrder: number;
};

export type CreateEnumOptionInput = {
  name: string;
  color?: string;
  enabled?: boolean;
  sortOrder?: number;
};

export type UpdateEnumOptionInput = {
  name?: string;
  color?: string;
  enabled?: boolean;
};

// Custom field definition types

export type CustomField = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  fieldType: CustomFieldType;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Number-specific fields
  precision: number | null;
  numberFormat: NumberFormat | null;
  currencyCode: string | null;
  customLabel: string | null;
  customLabelPosition: LabelPosition | null;
  // Behavior
  isGlobalToOrg: boolean;
  // Entity type applicability
  entityTypes: CustomFieldEntityType[];
  // Display configuration
  showInTable: boolean;
  isSearchable: boolean;
  isSortable: boolean;
};

/** Custom field definition with its enum options included. */
export type CustomFieldWithOptions = CustomField & {
  enumOptions: CustomFieldEnumOption[];
};

export type CreateCustomFieldInput = {
  name: string;
  description?: string;
  fieldType: CustomFieldType;
  // Number-specific
  precision?: number;
  numberFormat?: NumberFormat;
  currencyCode?: string;
  customLabel?: string;
  customLabelPosition?: LabelPosition;
  // Initial enum options (only valid for ENUM/MULTI_ENUM fields)
  enumOptions?: CreateEnumOptionInput[];
  // Entity type applicability
  entityTypes?: CustomFieldEntityType[];
  // Display configuration
  showInTable?: boolean;
  isSearchable?: boolean;
  isSortable?: boolean;
};

export type UpdateCustomFieldInput = {
  id: string;
  name?: string;
  description?: string;
  // Number-specific (fieldType itself is immutable after creation)
  precision?: number;
  numberFormat?: NumberFormat;
  currencyCode?: string;
  customLabel?: string;
  customLabelPosition?: LabelPosition;
  // Entity type applicability
  entityTypes?: CustomFieldEntityType[];
  // Display configuration
  showInTable?: boolean;
  isSearchable?: boolean;
  isSortable?: boolean;
};

// Custom field settings (field-to-entity-type attachment) types

export type CustomFieldSetting = {
  id: string;
  customFieldId: string;
  entityType: CustomFieldEntityType;
  entityId: string;
  isImportant: boolean;
  isRequired: boolean;
  sortOrder: number;
  createdAt: Date;
  customField: CustomField;
};

export type CustomFieldSettingWithOptions = Omit<
  CustomFieldSetting,
  "customField"
> & {
  customField: CustomFieldWithOptions;
};

export type AttachCustomFieldInput = {
  customFieldId: string;
  isImportant?: boolean;
  isRequired?: boolean;
  sortOrder?: number;
};

// Custom field value types

/**
 * A resolved custom field value for a specific entity instance.
 * Returned inline on entity GET responses (e.g., ProjectWithDetails.customFields).
 * Contains the field definition metadata plus the typed value and a pre-computed display string.
 */
export type CustomFieldValueDetail = {
  id: string;
  /** The custom field definition ID. */
  customFieldId: string;
  /** The entity instance this value belongs to. Used for grouping in batch list responses. */
  entityId: string;
  /** The custom field name (denormalized for convenience). */
  name: string;
  /** The custom field type (denormalized for rendering without extra fetches). */
  fieldType: CustomFieldType;
  /**
   * Pre-computed, safe-to-render string representation of the current value.
   * Populated for all field types. Empty string when no value is set.
   */
  displayValue: string | null;
  /** Whether this field should appear as a column in table views (from field definition). */
  showInTable: boolean;
  // Type-specific value fields — only one is populated per instance
  textValue: string | null;
  numberValue: number | null;
  dateValue: Date | null;
  /** Resolved enum option for ENUM fields. */
  enumValue: CustomFieldEnumOption | null;
  /** Resolved enum options for MULTI_ENUM fields. */
  multiEnumValues: CustomFieldEnumOption[];
  /** Resolved users for PEOPLE fields. */
  peopleValues: BasicUser[];
};
