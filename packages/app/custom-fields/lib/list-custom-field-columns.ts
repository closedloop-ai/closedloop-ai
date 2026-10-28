import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import { FIELD_TYPE_LABELS } from "@repo/app/custom-fields/components/constants";
import { z } from "zod";

/**
 * ISS-12663 — the custom-field columns a list surface draws, shared by the
 * Sessions and Branches lists so a field is one column, under one id, with one
 * header and tooltip, wherever it appears.
 */
export const LIST_CUSTOM_FIELD_COLUMN_PREFIX = "custom-field:";
export type ListCustomFieldColumnId =
  `${typeof LIST_CUSTOM_FIELD_COLUMN_PREFIX}${string}`;

export const LIST_CUSTOM_FIELD_WIDTH_PX = 180;

export type ListCustomFieldColumn = {
  id: ListCustomFieldColumnId;
  label: string;
  minWidthPx: number;
  width: string;
  tooltip: string;
  customField: CustomFieldWithOptions;
};

export function isListCustomFieldColumnId(
  value: string
): value is ListCustomFieldColumnId {
  return value.startsWith(LIST_CUSTOM_FIELD_COLUMN_PREFIX);
}

export function listCustomFieldColumnId(
  fieldId: string
): ListCustomFieldColumnId {
  return `${LIST_CUSTOM_FIELD_COLUMN_PREFIX}${fieldId}`;
}

/** One column per field the org shows in tables, in definition order. */
export function buildListCustomFieldColumns(
  fields: readonly CustomFieldWithOptions[]
): ListCustomFieldColumn[] {
  return fields
    .filter((field) => field.showInTable)
    .map((customField) => ({
      id: listCustomFieldColumnId(customField.id),
      label: customField.name,
      minWidthPx: LIST_CUSTOM_FIELD_WIDTH_PX,
      tooltip: `${FIELD_TYPE_LABELS[customField.fieldType]} field: ${customField.name}`,
      width: `${LIST_CUSTOM_FIELD_WIDTH_PX}px`,
      customField,
    }));
}

/**
 * ISS-10356: the ids whose width a saved view applies — a custom field's column,
 * built from `CustomField.id`, a Postgres `uuid`. The prefix alone would apply
 * any `custom-field:<anything>` a corrupt record holds, at any length (tamsinb,
 * PR #8117). Any other id stays version skew: carried, capped, and sheddable
 * (ISS-9449). Shared by the Sessions and Branches view states (ISS-12663).
 */
export function isListCustomFieldWidthColumnId(id: string): boolean {
  return (
    isListCustomFieldColumnId(id) &&
    CUSTOM_FIELD_ID_SCHEMA.safeParse(
      id.slice(LIST_CUSTOM_FIELD_COLUMN_PREFIX.length)
    ).success
  );
}

/** Any id a Postgres `uuid` column returns, not only an RFC 9562 one. */
const CUSTOM_FIELD_ID_SCHEMA = z.guid();
