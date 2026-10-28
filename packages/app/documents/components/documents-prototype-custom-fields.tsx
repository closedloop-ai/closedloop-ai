"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldFilterFacet,
  resolveCustomFieldCapabilities,
} from "@repo/api/src/types/custom-field-capabilities";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import { CustomFieldTableCell } from "@repo/app/custom-fields/components/custom-field-table-cell";
import {
  useCreateCustomField,
  useCustomFieldReferenceTargetSearch,
  useCustomFields,
  useUpdateCustomField,
  useUpdateCustomFieldValueForEntityType,
} from "@repo/app/custom-fields/hooks/use-custom-fields";
import { customFieldOptionColorFromDialogClass } from "@repo/app/custom-fields/lib/option-colors";
import {
  buildTableCustomFieldInput,
  existingCustomFieldOptions,
  TABLE_CUSTOM_FIELD_REFERENCE_SOURCES,
} from "@repo/app/custom-fields/lib/table-custom-field-creation";
import {
  type ArtifactListColumnExtension,
  columnWidthBounds,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import { TableAddFieldDialog } from "@repo/design-system/components/ui/table-add-field-dialog";
import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { documentKeys } from "../hooks/document-keys";

export function useDocumentsPrototypeCustomFields() {
  const { data: definitions = [] } = useCustomFields();
  const fields = useMemo(
    () =>
      definitions.filter(
        (field) =>
          field.entityTypes.includes(CustomFieldEntityType.Document) &&
          field.showInTable
      ),
    [definitions]
  );
  const availableFields = useMemo(
    () =>
      definitions.filter(
        (field) => !fields.some((visible) => visible.id === field.id)
      ),
    [definitions, fields]
  );
  const { mutateAsync: createField } = useCreateCustomField();
  const { mutateAsync: updateField } = useUpdateCustomField();
  const { mutateAsync: updateValue } = useUpdateCustomFieldValueForEntityType(
    CustomFieldEntityType.Document,
    ArtifactStatusEditSurface.InlineCell
  );
  const searchReferences = useCustomFieldReferenceTargetSearch();
  const { data: people } = useOrganizationUsers({
    enabled: fields.some((field) => field.fieldType === CustomFieldType.People),
  });
  const queryClient = useQueryClient();
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());
  const columns = useMemo(
    () => fields.map(documentCustomFieldColumn),
    [fields]
  );

  return {
    columns,
    fields,
    renderCell: (
      document: Pick<DocumentWithProject, "id" | "title" | "customFields">,
      columnId: string
    ) => {
      const field = fields.find(
        (candidate) => documentCustomFieldColumnId(candidate.id) === columnId
      );
      if (!field) {
        return undefined;
      }
      if (!document.customFields) {
        return <GridEmptyValue title="Unavailable" />;
      }
      return (
        <CustomFieldTableCell
          field={field}
          itemLabel={document.title}
          loadReferenceOptions={(query) =>
            searchReferences(field.id, query, document.id)
          }
          onValueChange={(value) => {
            const write = writeChain.current.then(async () => {
              await updateValue({
                entityId: document.id,
                fieldId: field.id,
                value,
              });
              await queryClient.invalidateQueries({
                queryKey: documentKeys.lists(),
              });
            });
            writeChain.current = write.catch(() => undefined);
            return write;
          }}
          ownerEntityId={document.id}
          peopleOptions={people}
          value={document.customFields.find(
            (value) => value.customFieldId === field.id
          )}
        />
      );
    },
    renderDialog: (
      open: boolean,
      onOpenChange: (open: boolean) => void,
      onCreated: (columnId: string) => void
    ) => (
      <TableAddFieldDialog
        existingFields={existingCustomFieldOptions(availableFields)}
        onCreate={async (draft) => {
          const input = buildTableCustomFieldInput(
            draft,
            CustomFieldEntityType.Document
          );
          const field = await createField({
            ...input,
            enumOptions: input.enumOptions?.map((option) => ({
              ...option,
              color: customFieldOptionColorFromDialogClass(option.color),
            })),
          });
          onCreated(documentCustomFieldColumnId(field.id));
        }}
        onOpenChange={onOpenChange}
        onSelectExisting={async (fieldId) => {
          const field = availableFields.find(
            (candidate) => candidate.id === fieldId
          );
          if (!field) {
            return;
          }
          await updateField({
            id: field.id,
            entityTypes: [
              ...new Set([
                ...field.entityTypes,
                CustomFieldEntityType.Document,
              ]),
            ],
            showInTable: true,
          });
          onCreated(documentCustomFieldColumnId(field.id));
        }}
        open={open}
        referenceSources={TABLE_CUSTOM_FIELD_REFERENCE_SOURCES}
      />
    ),
  };
}

export function documentCustomFieldColumnId(id: string) {
  return `${DOCUMENT_CUSTOM_FIELD_COLUMN_PREFIX}${id}`;
}

/** The custom field a column id names, or null for any other column. */
export function documentCustomFieldIdFromColumnId(
  columnId: string
): string | null {
  return columnId.startsWith(DOCUMENT_CUSTOM_FIELD_COLUMN_PREFIX)
    ? columnId.slice(DOCUMENT_CUSTOM_FIELD_COLUMN_PREFIX.length)
    : null;
}

export function documentCustomFieldCreationValues(
  document: Pick<DocumentWithProject, "customFields">
): NonNullable<GenericArtifact["creationValues"]> {
  const values: Record<
    string,
    NonNullable<GenericArtifact["creationValues"]>[string]
  > = {};
  for (const field of document.customFields ?? []) {
    const id = documentCustomFieldColumnId(field.customFieldId);
    const labels = customFieldLabels(field);
    values[id] = labels;
    values[`${id}:sort`] =
      field.numberValue ??
      (field.dateValue
        ? new Date(field.dateValue).getTime()
        : labels.join(", "));
  }
  return values;
}

function documentCustomFieldColumn(
  field: CustomFieldWithOptions
): ArtifactListColumnExtension {
  const id = documentCustomFieldColumnId(field.id);
  const capabilities = resolveCustomFieldCapabilities(field.fieldType);
  return {
    id,
    label: field.name,
    kind: ColumnFieldKind.Custom,
    width: columnWidthBounds(180),
    sortable: field.isSortable && capabilities.sortable,
    filterable: field.isSearchable,
    groupable: capabilities.groupable,
    sortValue: (artifact) => {
      const value = artifact.creationValues?.[`${id}:sort`];
      return typeof value === "number" || typeof value === "string"
        ? value
        : "";
    },
    filterValues: (artifact) => {
      const value = artifact.creationValues?.[id];
      return Array.isArray(value) ? value : [];
    },
    ...(capabilities.filter === CustomFieldFilterFacet.Range
      ? {
          filterRange: (artifact: GenericArtifact) => {
            const value = artifact.creationValues?.[`${id}:sort`];
            return typeof value === "number" ? value : Number.NaN;
          },
        }
      : {}),
    groupValue: (artifact) => {
      const value = artifact.creationValues?.[id];
      return Array.isArray(value) ? value.join(", ") : "";
    },
    renderCell: () => <GridEmptyValue title="Unavailable" />,
  };
}

function customFieldLabels(field: CustomFieldValueDetail): string[] {
  if (field.fieldType === CustomFieldType.Enum) {
    return field.enumValue ? [field.enumValue.name] : [];
  }
  if (field.fieldType === CustomFieldType.MultiEnum) {
    return field.multiEnumValues.map((option) => option.name);
  }
  if (field.fieldType === CustomFieldType.People) {
    return field.peopleValues.map(getUserDisplayName);
  }
  if (
    field.fieldType === CustomFieldType.Reference ||
    field.fieldType === CustomFieldType.ReferenceMulti
  ) {
    return (field.referenceValues ?? []).map((reference) => reference.name);
  }
  return field.displayValue ? [field.displayValue] : [];
}

const DOCUMENT_CUSTOM_FIELD_COLUMN_PREFIX = "custom-";
