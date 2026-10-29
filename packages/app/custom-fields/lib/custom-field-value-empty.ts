import {
  CustomFieldType,
  type CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";

/**
 * Whether an entity has no value for a custom field (ISS-12302): no stored
 * row, a null scalar or enum, or an empty multi-value list. The Details tab
 * hides a locked custom field that is empty and draws an editable one either
 * way.
 */
export function isCustomFieldValueEmpty(
  value: CustomFieldValueDetail | undefined
): boolean {
  if (value === undefined) {
    return true;
  }
  switch (value.fieldType) {
    case CustomFieldType.Text:
      return value.textValue === null;
    case CustomFieldType.Number:
      return value.numberValue === null;
    case CustomFieldType.Date:
      return value.dateValue === null;
    case CustomFieldType.Enum:
      return value.enumValue === null;
    case CustomFieldType.MultiEnum:
      return value.multiEnumValues.length === 0;
    case CustomFieldType.People:
      return value.peopleValues.length === 0;
    case CustomFieldType.Reference:
    case CustomFieldType.ReferenceMulti:
      return value.referenceValues.length === 0;
    default:
      return unknownTypeIsEmpty(value.fieldType);
  }
}

/**
 * A stored row of a type this build does not know (a newer server) cannot be
 * proven empty, so its locked row stays drawn. `never` keeps the switch above
 * exhaustive for the types this build does know.
 */
function unknownTypeIsEmpty(_fieldType: never): false {
  return false;
}
