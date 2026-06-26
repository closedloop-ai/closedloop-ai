import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";

export const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  [CustomFieldType.Text]: "Text",
  [CustomFieldType.Number]: "Number",
  [CustomFieldType.Enum]: "Single Select",
  [CustomFieldType.MultiEnum]: "Multi Select",
  [CustomFieldType.Date]: "Date",
  [CustomFieldType.People]: "People",
};

export const ENTITY_TYPE_LABELS: Record<CustomFieldEntityType, string> = {
  [CustomFieldEntityType.Project]: "Projects",
  [CustomFieldEntityType.Document]: "Documents",
};
