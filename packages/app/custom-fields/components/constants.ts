import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";

export const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  [CustomFieldType.Text]: "Text",
  [CustomFieldType.Number]: "Number",
  [CustomFieldType.Enum]: "Single select",
  [CustomFieldType.MultiEnum]: "Multi select",
  [CustomFieldType.Date]: "Date",
  [CustomFieldType.People]: "People",
  [CustomFieldType.Reference]: "Reference",
  [CustomFieldType.ReferenceMulti]: "Reference (multi)",
};

export const ENTITY_TYPE_LABELS: Record<CustomFieldEntityType, string> = {
  [CustomFieldEntityType.Project]: "Projects",
  [CustomFieldEntityType.Document]: "Documents",
  [CustomFieldEntityType.Session]: "Sessions",
  [CustomFieldEntityType.Branch]: "Branches",
};

/**
 * Field types the create dialog offers.
 *
 * Deliberately NOT every `CustomFieldType`. REFERENCE / REFERENCE_MULTI have
 * backend storage (ISS-7208) but no target picker and no case in
 * `CustomFieldValueEditor`, so offering them would let a user create a field
 * that cannot be given a value or a target source. They join this list with the
 * picker (ISS-7212), not before it.
 */
export const CREATABLE_FIELD_TYPES: CustomFieldType[] = [
  CustomFieldType.Text,
  CustomFieldType.Number,
  CustomFieldType.Enum,
  CustomFieldType.MultiEnum,
  CustomFieldType.Date,
  CustomFieldType.People,
];

/**
 * Read only through ISS-9590's rejection map, never at a call site: a literal
 * left at the one editor that refuses a date is a copy nothing holds to the
 * other surfaces. Its numeric sibling is owned a layer down, in
 * `packages/app/shared/lib/inline-scalar-invalid-message`, because the champion
 * needs the same sentence and `shared` may not load this slice.
 */
export const INVALID_DATE_MESSAGE = "Enter a valid date";
