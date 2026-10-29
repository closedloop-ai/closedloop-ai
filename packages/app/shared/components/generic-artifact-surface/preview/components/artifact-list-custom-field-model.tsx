import type { FilterMenuGroup } from "@repo/design-system/components/ui/filter-popover";
import {
  type TableCustomFieldDefinition as CustomFieldDefinition,
  TableCustomFieldType,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import type { Dispatch, SetStateAction } from "react";
import type { GenericArtifact } from "../fixtures";
import {
  type CustomFieldFilter,
  REFERENCE_SOURCE_KINDS,
  toggleArrayValue,
} from "./artifact-list-model";

export function customFieldValues(
  artifact: GenericArtifact,
  field: CustomFieldDefinition,
  referenceArtifacts: readonly GenericArtifact[]
): { textValues: string[]; numericValue?: number } {
  const createdValue = artifact.creationValues?.[field.id];
  if (typeof createdValue === "number") {
    return { numericValue: createdValue, textValues: [] };
  }
  if (typeof createdValue === "string") {
    return { textValues: createdValue ? [createdValue] : [] };
  }
  if (Array.isArray(createdValue)) {
    return { textValues: [...createdValue] };
  }
  const showEmptyState = Number(artifact.id.split("-").at(-1)) % 3 === 0;
  if (showEmptyState) {
    return { textValues: [] };
  }
  const optionIndex = artifact.title.length % (field.options?.length || 1);
  switch (field.type) {
    case TableCustomFieldType.SingleSelect:
      return { textValues: [field.options?.[optionIndex] ?? ""] };
    case TableCustomFieldType.MultiSelect:
      return { textValues: field.options?.slice(0, 2) ?? [] };
    case TableCustomFieldType.Date:
      return {
        textValues: [`Jul ${20 + (artifact.title.length % 9)}, 2026`],
      };
    case TableCustomFieldType.People:
      return { textValues: [artifact.owner] };
    case TableCustomFieldType.Reference:
      return {
        textValues: customFieldReferenceValues(
          field,
          referenceArtifacts,
          artifact
        ).slice(0, 1),
      };
    case TableCustomFieldType.ReferenceMulti:
      return {
        textValues: customFieldReferenceValues(
          field,
          referenceArtifacts,
          artifact
        ).slice(0, 3),
      };
    case TableCustomFieldType.Time:
      return {
        textValues: [],
        numericValue: 12 + artifact.title.length,
      };
    case TableCustomFieldType.Number:
      return {
        textValues: [],
        numericValue: 100 + artifact.title.length * 7,
      };
    case TableCustomFieldType.Text:
      return { textValues: ["Custom text value"] };
    default:
      return { textValues: [] };
  }
}

export function customFieldReferenceValues(
  field: CustomFieldDefinition,
  referenceArtifacts: readonly GenericArtifact[],
  artifact?: GenericArtifact
): string[] {
  const source = field.sources?.[0];
  const sourceKind = source ? REFERENCE_SOURCE_KINDS[source] : undefined;
  if (source && !sourceKind) {
    return [];
  }
  const candidates = referenceArtifacts.filter(
    (item) => !sourceKind || item.kind === sourceKind
  );
  if (!artifact || candidates.length < 2) {
    return candidates.map((item) => item.slug);
  }
  const startIndex = artifact.title.length % candidates.length;
  return [
    ...candidates.slice(startIndex),
    ...candidates.slice(0, startIndex),
  ].map((item) => item.slug);
}

export function matchesCustomFieldFilters(
  artifact: GenericArtifact,
  fields: CustomFieldDefinition[],
  filters: Record<string, CustomFieldFilter>,
  referenceArtifacts: readonly GenericArtifact[]
): boolean {
  return fields.every((field) => {
    const filter = filters[field.id];
    if (!filter) {
      return true;
    }
    const values = customFieldValues(artifact, field, referenceArtifacts);
    const matchesSelected =
      !filter.selectedValues?.length ||
      filter.selectedValues.some((selected) =>
        values.textValues.includes(selected)
      );
    const matchesMin =
      filter.min === undefined ||
      (values.numericValue !== undefined && values.numericValue >= filter.min);
    const matchesMax =
      filter.max === undefined ||
      (values.numericValue !== undefined && values.numericValue <= filter.max);
    return matchesSelected && matchesMin && matchesMax;
  });
}

export function buildCustomFieldFilterGroups(
  fields: CustomFieldDefinition[],
  artifacts: readonly GenericArtifact[],
  filters: Record<string, CustomFieldFilter>,
  setFilters: Dispatch<SetStateAction<Record<string, CustomFieldFilter>>>
): FilterMenuGroup[] {
  return fields.map((field) => {
    const filter = filters[field.id] ?? {};
    if (
      field.type === TableCustomFieldType.Number ||
      field.type === TableCustomFieldType.Time
    ) {
      return {
        kind: "range",
        id: field.id,
        label: field.label,
        min: filter.min,
        max: filter.max,
        minPlaceholder: "Min",
        maxPlaceholder: "Max",
        onChange: (next) =>
          setFilters((current) => ({
            ...current,
            [field.id]: next,
          })),
      };
    }
    const optionValues = [
      ...new Set(
        artifacts.flatMap(
          (artifact) => customFieldValues(artifact, field, artifacts).textValues
        )
      ),
    ].filter(Boolean);
    return {
      id: field.id,
      label: field.label,
      options: optionValues.map((value) => ({ id: value, label: value })),
      selectedValues: filter.selectedValues ?? [],
      onToggle: (value) =>
        setFilters((current) => ({
          ...current,
          [field.id]: {
            ...current[field.id],
            selectedValues: toggleArrayValue(
              current[field.id]?.selectedValues ?? [],
              value
            ),
          },
        })),
    };
  });
}
