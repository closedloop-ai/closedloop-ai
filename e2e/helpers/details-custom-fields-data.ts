/**
 * ISS-12302: the custom fields and values the Session and Branch Details
 * custom-field specs serve, on web and desktop. Kept free of Playwright and
 * `@repo/app` so the desktop spec loader can import it.
 */

import {
  type CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field.ts";
import { buildCustomField } from "./sessions-custom-field-mocks";

/**
 * UUIDs, as `CustomField.id` is: the desktop bridge admits a value write only
 * when both path ids are UUIDs (ISS-12302, `cloud-api-fetch-ipc.ts`).
 */
export const DETAILS_FIELD = {
  estimate: "0199f1c4-12d3-7a00-8b00-0000000000e2",
  labels: "0199f1c4-12d3-7a00-8b00-0000000000a4",
  notes: "0199f1c4-12d3-7a00-8b00-0000000000a5",
  risk: "0199f1c4-12d3-7a00-8b00-0000000000a1",
  severity: "0199f1c4-12d3-7a00-8b00-0000000000a3",
} as const;

export function detailsCustomFieldDefinitions(
  entityType: CustomFieldEntityType
): CustomFieldWithOptions[] {
  const entityTypes = [entityType];
  const option = (customFieldId: string, id: string, name: string) => ({
    color: "blue",
    customFieldId,
    enabled: true,
    id,
    name,
    sortOrder: 0,
  });
  return [
    buildCustomField({
      entityTypes,
      fieldType: CustomFieldType.Text,
      id: DETAILS_FIELD.risk,
      name: "Risk",
      showInTable: false,
    }),
    buildCustomField({
      entityTypes,
      fieldType: CustomFieldType.Number,
      id: DETAILS_FIELD.estimate,
      name: "Estimate",
      showInTable: false,
    }),
    buildCustomField({
      entityTypes,
      enumOptions: [
        option(DETAILS_FIELD.severity, "low", "Low"),
        option(DETAILS_FIELD.severity, "high", "High"),
      ],
      fieldType: CustomFieldType.Enum,
      id: DETAILS_FIELD.severity,
      name: "Severity",
      showInTable: false,
    }),
    buildCustomField({
      entityTypes,
      enumOptions: [
        option(DETAILS_FIELD.labels, "alpha", "Alpha"),
        option(DETAILS_FIELD.labels, "beta", "Beta"),
      ],
      fieldType: CustomFieldType.MultiEnum,
      id: DETAILS_FIELD.labels,
      name: "Labels",
      showInTable: false,
    }),
    buildCustomField({
      entityTypes,
      fieldType: CustomFieldType.Text,
      id: DETAILS_FIELD.notes,
      name: "Notes",
      showInTable: false,
    }),
  ];
}

/** Risk, Estimate and Severity are set; Labels and Notes are not. */
export function detailsCustomFieldValues(
  entityId: string,
  definitions: readonly CustomFieldWithOptions[]
): CustomFieldValueDetail[] {
  const byId = new Map(definitions.map((field) => [field.id, field]));
  return [
    valueDetail(entityId, byId.get(DETAILS_FIELD.risk), { textValue: "high" }),
    valueDetail(entityId, byId.get(DETAILS_FIELD.estimate), {
      numberValue: 3,
    }),
    valueDetail(entityId, byId.get(DETAILS_FIELD.severity), {
      enumValue: byId
        .get(DETAILS_FIELD.severity)
        ?.enumOptions.find((entry) => entry.id === "high"),
    }),
  ];
}

function valueDetail(
  entityId: string,
  field: CustomFieldWithOptions | undefined,
  patch: Partial<CustomFieldValueDetail>
): CustomFieldValueDetail {
  if (!field) {
    throw new Error("details custom-field fixture lost a field");
  }
  return {
    customFieldId: field.id,
    dateValue: null,
    displayValue: null,
    entityId,
    enumValue: null,
    fieldType: field.fieldType,
    id: `value-${field.id}`,
    multiEnumValues: [],
    name: field.name,
    numberValue: null,
    peopleValues: [],
    referenceValues: [],
    showInTable: false,
    textValue: null,
    ...patch,
  };
}

/** What the values service stores for one accepted write. */
export function storeValue(
  values: readonly CustomFieldValueDetail[],
  field: CustomFieldWithOptions,
  value: unknown,
  entityId: string
): CustomFieldValueDetail[] {
  const others = values.filter((entry) => entry.customFieldId !== field.id);
  if (value === null) {
    return others;
  }
  const options = (ids: readonly unknown[]) =>
    field.enumOptions.filter((entry) => ids.includes(entry.id));
  let patch: Partial<CustomFieldValueDetail> = {};
  if (typeof value === "number") {
    patch = { numberValue: value };
  } else if (Array.isArray(value)) {
    patch = { multiEnumValues: options(value) };
  } else if (field.fieldType === CustomFieldType.Enum) {
    patch = { enumValue: options([value])[0] ?? null };
  } else if (typeof value === "string") {
    patch = { textValue: value };
  }
  return [...others, valueDetail(entityId, field, patch)];
}
