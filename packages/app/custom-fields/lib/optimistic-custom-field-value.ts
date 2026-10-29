import {
  type CustomFieldReferenceTarget,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import type { CustomFieldTableValue } from "../components/custom-field-table-cell";

/** What an optimistic value is resolved from, besides the field itself. */
export type OptimisticCustomFieldLookups = {
  /** The entity the value belongs to, for a row that does not exist yet. */
  entityId: string;
  people: readonly BasicUser[];
  /** Targets the picker loaded; selected ones come from the current value. */
  referenceTargets: readonly CustomFieldReferenceTarget[];
};

/**
 * The entity's values with `field` set to `next`, built for display before the
 * write lands (ISS-12302's menu-based editors). `null` clears the row; an id
 * the lookups cannot resolve is left out until the refetch. Scalar types have
 * no optimistic shape (their editors write without one), so they return
 * `null` and the caller patches nothing.
 */
export function applyOptimisticCustomFieldValue(
  values: readonly CustomFieldValueDetail[],
  field: CustomFieldWithOptions,
  next: CustomFieldTableValue,
  lookups: OptimisticCustomFieldLookups
): CustomFieldValueDetail[] | null {
  const current = values.find((value) => value.customFieldId === field.id);
  const others = values.filter((value) => value.customFieldId !== field.id);
  if (next === null) {
    return others;
  }
  const patch = optimisticPatch(field, next, current, lookups);
  if (patch === null) {
    return null;
  }
  const base = current ?? emptyValueDetail(field, lookups.entityId);
  return [...others, { ...base, displayValue: null, ...patch }];
}

type OptimisticPatch = Partial<
  Pick<
    CustomFieldValueDetail,
    "enumValue" | "multiEnumValues" | "peopleValues" | "referenceValues"
  >
>;

function optimisticPatch(
  field: CustomFieldWithOptions,
  next: Exclude<CustomFieldTableValue, null>,
  current: CustomFieldValueDetail | undefined,
  lookups: OptimisticCustomFieldLookups
): OptimisticPatch | null {
  const ids = typeof next === "string" ? [next] : next;
  if (typeof ids === "number") {
    return null;
  }
  switch (field.fieldType) {
    case CustomFieldType.Enum:
      return { enumValue: pick(field.enumOptions, ids)[0] ?? null };
    case CustomFieldType.MultiEnum:
      return { multiEnumValues: pick(field.enumOptions, ids) };
    case CustomFieldType.People:
      return { peopleValues: pick(lookups.people, ids) };
    case CustomFieldType.Reference:
    case CustomFieldType.ReferenceMulti:
      return {
        referenceValues: pick(
          [...(current?.referenceValues ?? []), ...lookups.referenceTargets],
          ids
        ),
      };
    case CustomFieldType.Text:
    case CustomFieldType.Number:
    case CustomFieldType.Date:
      return null;
    default: {
      const unhandled: never = field.fieldType;
      return unhandled;
    }
  }
}

/** The entries named by `ids`, in `ids` order, each once. */
function pick<T extends { id: string }>(
  candidates: readonly T[],
  ids: readonly string[]
): T[] {
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate])
  );
  return [...new Set(ids)].flatMap((id) => {
    const found = byId.get(id);
    return found ? [found] : [];
  });
}

function emptyValueDetail(
  field: CustomFieldWithOptions,
  entityId: string
): CustomFieldValueDetail {
  return {
    customFieldId: field.id,
    dateValue: null,
    displayValue: null,
    entityId,
    enumValue: null,
    fieldType: field.fieldType,
    id: `optimistic:${field.id}`,
    multiEnumValues: [],
    name: field.name,
    numberValue: null,
    peopleValues: [],
    referenceValues: [],
    showInTable: field.showInTable,
    textValue: null,
  };
}
