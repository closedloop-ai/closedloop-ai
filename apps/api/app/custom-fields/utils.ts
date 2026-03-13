import type {
  CustomFieldEnumOption,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  LabelPosition,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";

/** Maximum number of custom field definitions per organization (AC-017). */
export const MAX_CUSTOM_FIELDS_PER_ORG = 500;

/** Maximum number of enum options per custom field (AC-017). */
export const MAX_ENUM_OPTIONS_PER_FIELD = 100;

/** Maximum number of characters for TEXT field values (AC-017). */
export const MAX_TEXT_VALUE_LENGTH = 10_000;

/**
 * Computes the human-readable display string for a custom field value.
 *
 * - TEXT: returns rawValue as-is
 * - NUMBER: formats with Intl.NumberFormat using field precision; currency style
 *   for CURRENCY format; prefix/suffix concatenation for CUSTOM format
 * - ENUM: returns the matching option name
 * - MULTI_ENUM: returns option names joined with ", "
 * - DATE: formats as "Jan 1, 2024" in en-US locale
 * - PEOPLE: resolves user names from the database as "First L." joined with ", "
 *
 * @param field - The custom field definition (with options for ENUM/MULTI_ENUM).
 * @param rawValue - The raw stored value (string, number, or string[]).
 * @param options - Optional pre-loaded enum options (avoids DB round-trip).
 * @param people - Optional pre-loaded user records (avoids DB round-trip for PEOPLE).
 */
export async function computeDisplayValue(
  field: CustomFieldWithOptions,
  rawValue: string | number | string[] | null,
  options?: CustomFieldEnumOption[],
  people?: { firstName: string | null; lastName: string | null }[]
): Promise<string> {
  if (rawValue === null || rawValue === undefined) {
    return "";
  }

  switch (field.fieldType) {
    case CustomFieldType.Text: {
      return String(rawValue);
    }

    case CustomFieldType.Number: {
      const num = Number(rawValue);
      if (Number.isNaN(num)) {
        return String(rawValue);
      }
      return formatNumber(field, num);
    }

    case CustomFieldType.Enum: {
      const id = String(rawValue);
      const enumOptions = options ?? field.enumOptions;
      const match = enumOptions.find((opt) => opt.id === id);
      return match?.name ?? "";
    }

    case CustomFieldType.MultiEnum: {
      const ids = Array.isArray(rawValue) ? rawValue : [String(rawValue)];
      const enumOptions = options ?? field.enumOptions;
      const names = ids
        .map((id) => enumOptions.find((opt) => opt.id === id)?.name)
        .filter((name): name is string => name !== undefined);
      return names.join(", ");
    }

    case CustomFieldType.Date: {
      const date = new Date(String(rawValue));
      if (Number.isNaN(date.getTime())) {
        return String(rawValue);
      }
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }

    case CustomFieldType.People: {
      const ids = Array.isArray(rawValue) ? rawValue : [String(rawValue)];
      if (ids.length === 0) {
        return "";
      }
      const resolved =
        people ?? (await resolvePeopleNames(ids, field.organizationId));
      const names = resolved.map(formatPersonName).filter(Boolean);
      return names.join(", ");
    }

    default: {
      return String(rawValue);
    }
  }
}

/**
 * Formats a numeric value according to the field's number format configuration.
 */
function formatNumber(field: CustomFieldWithOptions, num: number): string {
  const precision = field.precision ?? 0;
  const format = field.numberFormat ?? NumberFormat.None;

  if (format === NumberFormat.Currency) {
    const currencyCode = field.currencyCode ?? "USD";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(num);
  }

  if (format === NumberFormat.Percentage) {
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(num / 100);
  }

  if (format === NumberFormat.Custom) {
    const formatted = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(num);
    const label = field.customLabel ?? "";
    const position = field.customLabelPosition ?? LabelPosition.Suffix;
    return position === LabelPosition.Prefix
      ? `${label}${formatted}`
      : `${formatted}${label}`;
  }

  // NumberFormat.None — plain number with precision
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(num);
}

/**
 * Resolves user display names for PEOPLE field values by querying the database.
 * Uses the same field selection shape as basicUserSelect from @/lib/db-utils.
 */
function resolvePeopleNames(
  ids: string[],
  organizationId: string
): Promise<{ firstName: string | null; lastName: string | null }[]> {
  return withDb((db) =>
    db.user.findMany({
      where: { id: { in: ids }, organizationId },
      select: { firstName: true, lastName: true },
    })
  );
}

/**
 * Formats a user's name as "First L." (first name + last name initial + period).
 */
function formatPersonName(person: {
  firstName: string | null;
  lastName: string | null;
}): string {
  const first = person.firstName?.trim() ?? "";
  const lastInitial = person.lastName?.[0] ?? "";
  if (!first) {
    return lastInitial ? `${lastInitial}.` : "";
  }
  return lastInitial ? `${first} ${lastInitial}.` : first;
}

/**
 * Throws an error if the organization has reached the custom field definition limit.
 *
 * Call this before creating a new custom field definition to enforce AC-017.
 *
 * @param organizationId - The organization to check.
 * @throws Error if the org already has MAX_CUSTOM_FIELDS_PER_ORG fields.
 */
export function checkFieldLimit(organizationId: string): Promise<void> {
  return withDb(async (db) => {
    const count = await db.customField.count({ where: { organizationId } });
    if (count >= MAX_CUSTOM_FIELDS_PER_ORG) {
      throw new Error(
        `Organization has reached the maximum of ${MAX_CUSTOM_FIELDS_PER_ORG} custom field definitions.`
      );
    }
  });
}

/**
 * Throws an error if the custom field has reached the enum option limit.
 *
 * Call this before creating a new enum option to enforce AC-017.
 *
 * @param customFieldId - The custom field to check.
 * @throws Error if the field already has MAX_ENUM_OPTIONS_PER_FIELD options.
 */
export function checkOptionLimit(customFieldId: string): Promise<void> {
  return withDb(async (db) => {
    const count = await db.customFieldEnumOption.count({
      where: { customFieldId },
    });
    if (count >= MAX_ENUM_OPTIONS_PER_FIELD) {
      throw new Error(
        `Custom field has reached the maximum of ${MAX_ENUM_OPTIONS_PER_FIELD} enum options.`
      );
    }
  });
}

/**
 * Validates that the provided value matches the expected type for a custom field.
 *
 * Throws a descriptive error on type mismatch. Does not throw for null (clearing a value).
 *
 * - TEXT: expects string (max 10,000 chars)
 * - NUMBER: expects number or numeric string
 * - ENUM: expects string (option ID)
 * - MULTI_ENUM: expects string[] (array of option IDs)
 * - DATE: expects ISO 8601 date string parseable by Date constructor
 * - PEOPLE: expects string[] (array of user IDs)
 *
 * @param fieldType - The declared type of the custom field.
 * @param value - The raw value to validate.
 * @throws Error with a descriptive message on mismatch.
 */
export function validateValueType(
  fieldType: CustomFieldType,
  value: string | number | string[] | null
): void {
  if (value === null) {
    return;
  }

  switch (fieldType) {
    case CustomFieldType.Text: {
      validateTextValue(value);
      break;
    }
    case CustomFieldType.Number: {
      validateNumberValue(value);
      break;
    }
    case CustomFieldType.Enum: {
      validateEnumValue(value);
      break;
    }
    case CustomFieldType.MultiEnum: {
      validateStringArrayValue("MULTI_ENUM", value);
      break;
    }
    case CustomFieldType.Date: {
      validateDateValue(value);
      break;
    }
    case CustomFieldType.People: {
      validateStringArrayValue("PEOPLE", value);
      break;
    }
    default: {
      throw new Error(`Unknown field type: ${fieldType satisfies never}.`);
    }
  }
}

function validateTextValue(value: string | number | string[]): void {
  if (typeof value !== "string") {
    throw new Error(
      `Invalid value for TEXT field: expected a string, got ${typeof value}.`
    );
  }
  if (value.length > MAX_TEXT_VALUE_LENGTH) {
    throw new Error(
      `TEXT field value exceeds the maximum length of ${MAX_TEXT_VALUE_LENGTH} characters.`
    );
  }
}

function validateNumberValue(value: string | number | string[]): void {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(
      `Invalid value for NUMBER field: expected a number, got ${typeof value}.`
    );
  }
  if (Number.isNaN(Number(value))) {
    throw new Error(
      `Invalid value for NUMBER field: "${String(value)}" is not a valid number.`
    );
  }
}

function validateEnumValue(value: string | number | string[]): void {
  if (typeof value !== "string") {
    throw new Error(
      `Invalid value for ENUM field: expected a string option ID, got ${typeof value}.`
    );
  }
}

function validateStringArrayValue(
  fieldLabel: "MULTI_ENUM" | "PEOPLE",
  value: string | number | string[]
): void {
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid value for ${fieldLabel} field: expected an array, got ${typeof value}.`
    );
  }
  const invalid = value.find((v) => typeof v !== "string");
  if (invalid !== undefined) {
    throw new Error(
      `Invalid value for ${fieldLabel} field: all items must be strings, got ${typeof invalid}.`
    );
  }
}

function validateDateValue(value: string | number | string[]): void {
  if (typeof value !== "string") {
    throw new Error(
      `Invalid value for DATE field: expected an ISO 8601 date string, got ${typeof value}.`
    );
  }
  if (Number.isNaN(new Date(value).getTime())) {
    throw new Error(
      `Invalid value for DATE field: "${value}" is not a valid date string.`
    );
  }
}

// ---------------------------------------------------------------------------
// Reserved field name validation
// ---------------------------------------------------------------------------

/**
 * Built-in property names per entity type that cannot be used as custom field names.
 * Case-insensitive comparison is used to prevent naming conflicts with existing
 * entity properties shown in the UI.
 */
const RESERVED_NAMES_BY_ENTITY_TYPE: Record<
  CustomFieldEntityType,
  ReadonlySet<string>
> = {
  [CustomFieldEntityType.Project]: new Set([
    "name",
    "description",
    "status",
    "priority",
    "assignee",
    "team",
    "target date",
    "codebase summary",
    "slug",
  ]),
  [CustomFieldEntityType.Workstream]: new Set([
    "title",
    "description",
    "type",
    "state",
    "status",
    "priority",
    "assignee",
    "slug",
  ]),
  [CustomFieldEntityType.Issue]: new Set([
    "title",
    "description",
    "status",
    "priority",
    "assignee",
    "workstream",
    "slug",
  ]),
  [CustomFieldEntityType.Artifact]: new Set([
    "title",
    "description",
    "type",
    "status",
    "assignee",
    "approver",
    "target repository",
    "target branch",
    "version",
    "slug",
  ]),
};

/** Friendly display labels for entity types shown in error messages. */
const ENTITY_TYPE_DISPLAY_NAMES: Record<CustomFieldEntityType, string> = {
  [CustomFieldEntityType.Project]: "Project",
  [CustomFieldEntityType.Workstream]: "Feature",
  [CustomFieldEntityType.Issue]: "Issue",
  [CustomFieldEntityType.Artifact]: "Artifact",
};

/**
 * Thrown when a custom field name conflicts with a built-in property name
 * on one of its target entity types.
 */
export class ReservedNameError extends Error {
  constructor(name: string, entityType: CustomFieldEntityType) {
    const label = ENTITY_TYPE_DISPLAY_NAMES[entityType] ?? entityType;
    super(
      `"${name}" is a built-in property of ${label} and cannot be used as a custom field name.`
    );
    this.name = "ReservedNameError";
  }
}

/**
 * Validates that a custom field name does not conflict with built-in entity property names.
 *
 * Checks the name (case-insensitive) against reserved names for each target entity type.
 * Throws ReservedNameError if a conflict is found.
 *
 * @param fieldName - The custom field name to validate.
 * @param entityTypes - The entity types this field targets.
 */
export function validateFieldNameNotReserved(
  fieldName: string,
  entityTypes: CustomFieldEntityType[]
): void {
  const normalizedName = fieldName.trim().toLowerCase();
  for (const entityType of entityTypes) {
    const reserved = RESERVED_NAMES_BY_ENTITY_TYPE[entityType];
    if (reserved?.has(normalizedName)) {
      throw new ReservedNameError(fieldName, entityType);
    }
  }
}
