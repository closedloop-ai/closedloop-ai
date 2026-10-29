/**
 * ISS-12663: the TableAddFieldDialog wire adapter every list that offers Add
 * field submits through (the draft → create-input mapping, reference sources and
 * existing-field options). Moved here from the Sessions list, which built it
 * first, so the shared controls do not depend on one of their consumers.
 */
import type {
  CreateCustomFieldInput,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  type CustomFieldEntityType,
  CustomFieldType,
  LabelPosition,
  NumberFormat,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { FIELD_TYPE_LABELS } from "@repo/app/custom-fields/components/constants";
import {
  type TableCustomFieldDraft,
  type TableCustomFieldReferenceSource,
  TableCustomFieldTimeFormat,
  TableCustomFieldType,
  type TableExistingCustomFieldOption,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  GitBranchIcon,
  HistoryIcon,
  Layers2Icon,
  SquareCheckIcon,
} from "lucide-react";

export function buildTableCustomFieldInput(
  draft: TableCustomFieldDraft,
  entityType: CustomFieldEntityType
): CreateCustomFieldInput {
  const typeConfig = tableFieldTypeConfig(draft);
  const referenceTargetSources = (draft.sources ?? []).flatMap((source) => {
    const match = Object.values(ReferenceTargetSource).find(
      (candidate) => candidate === source
    );
    return match ? [match] : [];
  });
  return {
    ...typeConfig,
    description: draft.description,
    entityTypes: [entityType],
    enumOptions: draft.options?.map((name, index) => ({
      color: draft.optionColors?.[index],
      name,
      sortOrder: index,
    })),
    isSearchable: true,
    isSortable: true,
    name: draft.label,
    referenceTargetSources:
      referenceTargetSources.length > 0 ? referenceTargetSources : undefined,
    showInTable: true,
  };
}

export function existingCustomFieldOptions(
  fields: readonly CustomFieldWithOptions[]
): TableExistingCustomFieldOption[] {
  return fields.map((field) => ({
    description: field.description ?? undefined,
    id: field.id,
    label: field.name,
    typeLabel: FIELD_TYPE_LABELS[field.fieldType],
  }));
}

export const TABLE_CUSTOM_FIELD_REFERENCE_SOURCES: readonly TableCustomFieldReferenceSource[] =
  [
    {
      icon: Layers2Icon,
      label: "Artifacts",
      value: ReferenceTargetSource.Artifact,
    },
    {
      icon: HistoryIcon,
      label: "Sessions",
      value: ReferenceTargetSource.Session,
    },
    {
      icon: SquareCheckIcon,
      label: "Issues",
      value: ReferenceTargetSource.Issue,
    },
    {
      icon: GitBranchIcon,
      label: "Branches",
      value: ReferenceTargetSource.Branch,
    },
  ];

function tableFieldTypeConfig(
  draft: TableCustomFieldDraft
): Pick<
  CreateCustomFieldInput,
  | "fieldType"
  | "numberFormat"
  | "precision"
  | "customLabel"
  | "customLabelPosition"
> {
  if (draft.type !== TableCustomFieldType.Time) {
    return { fieldType: TABLE_FIELD_TYPE_MAP[draft.type] };
  }
  if (draft.timeFormat === TableCustomFieldTimeFormat.Decimal) {
    return {
      customLabel: "hours",
      customLabelPosition: LabelPosition.Suffix,
      fieldType: CustomFieldType.Number,
      numberFormat: NumberFormat.Custom,
      precision: 2,
    };
  }
  if (draft.timeFormat === TableCustomFieldTimeFormat.Minutes) {
    return {
      customLabel: "minutes",
      customLabelPosition: LabelPosition.Suffix,
      fieldType: CustomFieldType.Number,
      numberFormat: NumberFormat.Custom,
      precision: 0,
    };
  }
  return {
    fieldType: CustomFieldType.Number,
    numberFormat: NumberFormat.Duration,
  };
}

const TABLE_FIELD_TYPE_MAP: Readonly<
  Record<Exclude<TableCustomFieldType, "Time">, CustomFieldType>
> = {
  [TableCustomFieldType.SingleSelect]: CustomFieldType.Enum,
  [TableCustomFieldType.MultiSelect]: CustomFieldType.MultiEnum,
  [TableCustomFieldType.Date]: CustomFieldType.Date,
  [TableCustomFieldType.People]: CustomFieldType.People,
  [TableCustomFieldType.Reference]: CustomFieldType.Reference,
  [TableCustomFieldType.ReferenceMulti]: CustomFieldType.ReferenceMulti,
  [TableCustomFieldType.Text]: CustomFieldType.Text,
  [TableCustomFieldType.Number]: CustomFieldType.Number,
};
