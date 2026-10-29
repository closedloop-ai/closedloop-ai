import type {
  CustomFieldEnumOption,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  LabelPosition,
  MAX_CUSTOM_FIELDS_PER_ORG,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import {
  CUSTOM_FIELD_DATE_MAX_YEAR,
  CUSTOM_FIELD_DATE_MIN_YEAR,
  isCustomFieldDateYearInRange,
} from "@repo/api/src/types/custom-field-date";
import {
  formatCustomFieldDurationMs,
  isValidCustomFieldDurationMs,
  parseCustomFieldDurationMs,
} from "@repo/api/src/types/custom-field-duration";
import type { BasicUser } from "@repo/api/src/types/user";
import { withDb } from "@repo/database";
import { parseFiniteNumberInput } from "@repo/lib/custom-fields/finite-number-input";
import { formatPeopleSortKey } from "./display-value";
import { resolvePeopleMap } from "./people-resolution";
import { InvalidReferenceTargetError } from "./reference-targets";

/** Maximum number of enum options per custom field (AC-017). */
export const MAX_ENUM_OPTIONS_PER_FIELD = 100;

/** Maximum number of characters for TEXT field values (AC-017). */
export const MAX_TEXT_VALUE_LENGTH = 10_000;

/**
 * Separator between option names in a MULTI_ENUM field's display value.
 *
 * `enumOptionsService` re-derives the same string in SQL on rename, so this is
 * the one place the separator is declared.
 */
export const MULTI_ENUM_DISPLAY_SEPARATOR = ", ";

/**
 * Computes the human-readable display string for a custom field value.
 *
 * - TEXT: returns rawValue as-is
 * - NUMBER: formats with Intl.NumberFormat using field precision; currency style
 *   for CURRENCY format; prefix/suffix concatenation for CUSTOM format; an
 *   elapsed span from the stored milliseconds for DURATION format
 * - ENUM: returns the matching option name
 * - MULTI_ENUM: returns option names joined with ", "
 * - DATE: formats as "Jan 1, 2024" in en-US locale
 * - PEOPLE: user names as "First L." joined with ", ", in stored-id order
 *
 * @param field - The custom field definition (with options for ENUM/MULTI_ENUM).
 * @param rawValue - The raw stored value (string, number, or string[]).
 * @param options - Optional pre-loaded enum options (avoids DB round-trip).
 * @param peopleById - Optional pre-resolved users, KEYED BY ID (avoids a DB
 *   round-trip for PEOPLE). A map on purpose, not the ordered array this used to
 *   take: the order a PEOPLE string renders in must come from the stored
 *   `peopleValueIds` and nothing else, so a caller must not be able to supply
 *   one. That parameter was the bypass that let this path and the read path
 *   disagree about sequence (ISS-7215).
 */
export async function computeDisplayValue(
  field: CustomFieldWithOptions,
  rawValue: string | number | string[] | null,
  options?: CustomFieldEnumOption[],
  peopleById?: Map<string, BasicUser>
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
      return names.join(MULTI_ENUM_DISPLAY_SEPARATOR);
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

    // The string cached here is the SORT KEY, not what a read renders — PEOPLE
    // is `ResolvedOnRead` (DISPLAY_VALUE_STRATEGY), so `resolveDisplayValue`
    // derives the rendered string from the same users on every read. Both sides
    // order through `orderRowsBy` against the stored ids and format through
    // `formatPeopleDisplayValue` (`formatPeopleSortKey` is that pair, named),
    // so the key and the label cannot disagree. A user rename re-derives the
    // cached key through the same helper (`refreshPeopleDisplayValuesForUser`).
    case CustomFieldType.People: {
      const ids = Array.isArray(rawValue) ? rawValue : [String(rawValue)];
      if (ids.length === 0) {
        return "";
      }
      const byId =
        peopleById ?? (await resolvePeopleMap(ids, field.organizationId));
      return formatPeopleSortKey(ids, byId);
    }

    // Reference display strings are resolved from the target artifacts on read
    // and never persisted (DISPLAY_VALUE_STRATEGY). Returning "" here keeps the
    // stored column empty for these types, so a stale string can never be read
    // back even if a future caller forgets the strategy check.
    case CustomFieldType.Reference:
    case CustomFieldType.ReferenceMulti: {
      return "";
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

  if (format === NumberFormat.Duration) {
    // Milliseconds in, elapsed span out — the unit is the field's contract, not
    // this formatter's choice. `precision` does not apply: a duration's
    // granularity is its unit ladder.
    //
    // A negative or non-finite span is NOT a duration. The write path rejects
    // both, so reaching here means a corrupt row — and rendering it as `""`
    // would make it identical to a field nobody ever set. Fall through to the
    // plain number instead: the bad value stays visible and stays distinct from
    // an absence.
    if (isValidCustomFieldDurationMs(num)) {
      return formatCustomFieldDurationMs(num);
    }
    return formatPlainNumber(num, precision);
  }

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
  return formatPlainNumber(num, precision);
}

/** Plain localized number — the NONE format, and the corrupt-duration fallback. */
function formatPlainNumber(num: number, precision: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(num);
}

/**
 * Resolves a DURATION field's raw input to canonical milliseconds, or `null`
 * when it is not a duration at all.
 *
 * The wire accepts both spellings on purpose: a number is already milliseconds
 * (what a machine-populated cycle-time column sends), and a string is the human
 * span a person types. Normalizing here — rather than in the editor alone —
 * is what makes the round trip hold for every client, including an API-key
 * caller that never loads the editor.
 */
export function coerceCustomFieldDurationMs(
  value: string | number
): number | null {
  if (typeof value === "number") {
    return isValidCustomFieldDurationMs(value) ? value : null;
  }
  return parseCustomFieldDurationMs(value);
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
 * @param numberFormat - The field's number format. Only NUMBER fields consult
 *   it, and only DURATION narrows what is accepted (see validateNumberValue).
 * @throws Error with a descriptive message on mismatch.
 */
export function validateValueType(
  fieldType: CustomFieldType,
  value: string | number | string[] | null,
  numberFormat?: NumberFormat | null
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
      validateNumberValue(value, numberFormat);
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
    case CustomFieldType.Reference: {
      validateReferenceShape(CustomFieldType.Reference, value);
      break;
    }
    case CustomFieldType.ReferenceMulti: {
      validateReferenceShape(CustomFieldType.ReferenceMulti, value);
      break;
    }
    default: {
      throw new InvalidFieldValueError(
        `Unknown field type: ${fieldType satisfies never}.`
      );
    }
  }
}

function validateTextValue(value: string | number | string[]): void {
  if (typeof value !== "string") {
    throw new InvalidFieldValueError(
      `Invalid value for TEXT field: expected a string, got ${typeof value}.`
    );
  }
  if (value.length > MAX_TEXT_VALUE_LENGTH) {
    throw new InvalidFieldValueError(
      `TEXT field value exceeds the maximum length of ${MAX_TEXT_VALUE_LENGTH} characters.`
    );
  }
}

function validateNumberValue(
  value: string | number | string[],
  numberFormat?: NumberFormat | null
): void {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new InvalidFieldValueError(
      `Invalid value for NUMBER field: expected a number, got ${typeof value}.`
    );
  }
  // A duration is a narrower number that also accepts a human spelling, so it
  // is validated against the parser rather than against `Number()` — "1h 12m"
  // is a legal duration and an illegal plain number.
  if (numberFormat === NumberFormat.Duration) {
    if (coerceCustomFieldDurationMs(value) === null) {
      throw new InvalidFieldValueError(
        `Invalid value for DURATION field: "${String(value)}" is not a finite, non-negative duration (expected milliseconds, or a span like "1h 12m").`
      );
    }
    return;
  }
  if (parseFiniteNumberInput(value) === null) {
    throw new InvalidFieldValueError(
      `Invalid value for NUMBER field: "${String(value)}" is not a valid number.`
    );
  }
}

function validateEnumValue(value: string | number | string[]): void {
  if (typeof value !== "string") {
    throw new InvalidFieldValueError(
      `Invalid value for ENUM field: expected a string option ID, got ${typeof value}.`
    );
  }
}

/**
 * Shape-only check for reference values. Whether the named targets exist and
 * are of a permitted source is decided against the database in
 * `reference-targets.ts`; this stays synchronous like every other case here.
 */
function validateReferenceShape(
  fieldType:
    | typeof CustomFieldType.Reference
    | typeof CustomFieldType.ReferenceMulti,
  value: string | number | string[]
): void {
  // InvalidReferenceTargetError, not a bare Error: a malformed reference value
  // is a caller mistake, and the routes map only this class to a 400. Throwing
  // the generic shape here would report a client error as a 500.
  if (fieldType === CustomFieldType.Reference) {
    if (typeof value !== "string") {
      throw new InvalidReferenceTargetError(
        `Invalid value for REFERENCE field: expected a single artifact ID, got ${Array.isArray(value) ? "an array" : typeof value}. Use REFERENCE_MULTI for multiple targets.`
      );
    }
    return;
  }
  if (!Array.isArray(value)) {
    throw new InvalidReferenceTargetError(
      `Invalid value for REFERENCE_MULTI field: expected an array, got ${typeof value}.`
    );
  }
}

function validateStringArrayValue(
  fieldLabel: "MULTI_ENUM" | "PEOPLE",
  value: string | number | string[]
): void {
  if (!Array.isArray(value)) {
    throw new InvalidFieldValueError(
      `Invalid value for ${fieldLabel} field: expected an array, got ${typeof value}.`
    );
  }
  const invalid = value.find((v) => typeof v !== "string");
  if (invalid !== undefined) {
    throw new InvalidFieldValueError(
      `Invalid value for ${fieldLabel} field: all items must be strings, got ${typeof invalid}.`
    );
  }
}

function validateDateValue(value: string | number | string[]): void {
  if (typeof value !== "string") {
    throw new InvalidFieldValueError(
      `Invalid value for DATE field: expected an ISO 8601 date string, got ${typeof value}.`
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidFieldValueError(
      `Invalid value for DATE field: "${value}" is not a valid date string.`
    );
  }
  if (!isCustomFieldDateYearInRange(parsed)) {
    throw new InvalidFieldValueError(
      `Invalid value for DATE field: "${value}" must fall in UTC years ${String(CUSTOM_FIELD_DATE_MIN_YEAR).padStart(4, "0")} to ${CUSTOM_FIELD_DATE_MAX_YEAR}.`
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
  [CustomFieldEntityType.Document]: new Set([
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
  [CustomFieldEntityType.Session]: new Set([
    "status",
    "harness",
    "agent",
    "started",
    "ended",
    "duration",
    "cost",
    "repository",
    "branch",
    "user",
  ]),
  [CustomFieldEntityType.Branch]: new Set([
    "name",
    "status",
    "repository",
    "owner",
    "pull request",
    "lines changed",
    "cost",
    "sessions",
    "created",
    "updated",
  ]),
};

/** Friendly display labels for entity types shown in error messages. */
const ENTITY_TYPE_DISPLAY_NAMES: Record<CustomFieldEntityType, string> = {
  [CustomFieldEntityType.Project]: "Project",
  [CustomFieldEntityType.Document]: "Document",
  [CustomFieldEntityType.Session]: "Session",
  [CustomFieldEntityType.Branch]: "Branch",
};

/**
 * Thrown when a submitted VALUE is rejected: a type mismatch, a disabled or
 * unknown enum option, a user outside the organization, a non-duration span.
 *
 * A distinct class, not a bare `Error`, because the route layer maps this to a
 * 400. `PrismaClientKnownRequestError` and friends are also `Error`, so an
 * `instanceof Error` arm would hand a connection failure or a timeout the same
 * non-retryable 400 — with the raw driver message as the body, and skipping the
 * `errorResponse` logging that makes a DB incident visible.
 */
export class InvalidFieldValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFieldValueError";
  }
}

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
