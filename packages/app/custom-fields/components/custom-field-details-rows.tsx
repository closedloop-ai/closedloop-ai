"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type CustomFieldEntityType,
  type CustomFieldReferenceSearchResponse,
  type CustomFieldReferenceTarget,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import type { DetailsField } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import {
  CustomFieldEditor,
  resolveCustomFieldEditor,
} from "@repo/lib/custom-fields/custom-field-editor";
import { useMemo, useRef } from "react";
import {
  useCustomFieldReferenceTargetSearch,
  useCustomFields,
} from "../hooks/use-custom-fields";
import { useEntityCustomFieldValueWrite } from "../hooks/use-entity-custom-field-value-write";
import {
  type ReadEntityCustomFieldValues,
  useEntityCustomFieldValues,
} from "../hooks/use-entity-custom-field-values";
import { isCustomFieldValueEmpty } from "../lib/custom-field-value-empty";
import { CustomFieldScalarEditor } from "./custom-field-scalar-editor";
import {
  CustomFieldTableCell,
  type CustomFieldTableValue,
  renderCustomFieldTableValue,
} from "./custom-field-table-cell";

type LoadReferenceOptions = (
  query: string
) => Promise<CustomFieldReferenceSearchResponse>;

/**
 * ISS-12302: one Details row per custom field that applies to the entity,
 * each editing and saving itself.
 *
 * - Rows are the org's definitions whose `entityTypes` include `entityType`,
 *   in `GET /custom-fields` order, as the Sessions list and the Issue page
 *   pick them.
 * - No `readValues` (desktop Local mode) means no rows and no requests.
 * - While either read is loading, or once one has failed, there are no rows,
 *   so the host draws no Custom fields section and no new copy (Kerensa,
 *   2026-10-08, ISS-12302), as the Sessions list draws no custom-field
 *   columns then.
 * - A type with no editor in this build is read-only, so it is hidden when
 *   empty, as a field that cannot be edited is (Kerensa, 2026-10-08).
 */
export function useCustomFieldDetailsRows({
  entityType,
  entityId,
  itemLabel,
  readValues,
}: {
  entityType: CustomFieldEntityType;
  entityId: string;
  /** The session's name or the branch's name, for the editors' names. */
  itemLabel: string;
  readValues: ReadEntityCustomFieldValues | undefined;
}): readonly DetailsField[] {
  const enabled = readValues !== undefined;
  const definitions = useCustomFields({ enabled });
  const values = useEntityCustomFieldValues({
    entityType,
    entityId,
    readValues,
  });
  const fields = useMemo(
    () =>
      (Array.isArray(definitions.data) ? definitions.data : []).filter(
        (field) => field.entityTypes.includes(entityType)
      ),
    [definitions.data, entityType]
  );
  const needsPeople = fields.some(
    (field) => field.fieldType === CustomFieldType.People
  );
  const { data: people } = useOrganizationUsers({
    enabled: enabled && needsPeople,
  });
  const write = useEntityCustomFieldValueWrite(
    entityType,
    entityId,
    ArtifactStatusEditSurface.Detail
  );
  const searchReferenceTargets = useCustomFieldReferenceTargetSearch();
  // The page of each reference picker's newest load, so a just-picked target
  // can be shown before the write lands. A slower, older response is not
  // stored: the picker shows the newer page, and its picks resolve from it.
  const loadedTargets = useRef(
    new Map<string, readonly CustomFieldReferenceTarget[]>()
  );
  const newestLoad = useRef(new Map<string, number>());
  const referenceLoaders = useMemo(
    () =>
      new Map(
        fields.map((field): [string, LoadReferenceOptions] => [
          field.id,
          (query) => {
            const load = (newestLoad.current.get(field.id) ?? 0) + 1;
            newestLoad.current.set(field.id, load);
            return searchReferenceTargets(field.id, query, entityId).then(
              (result) => {
                if (newestLoad.current.get(field.id) === load) {
                  loadedTargets.current.set(field.id, result.targets);
                }
                return result;
              }
            );
          },
        ])
      ),
    [entityId, fields, searchReferenceTargets]
  );

  const ready =
    enabled && Array.isArray(definitions.data) && Array.isArray(values.data);
  const valueData = values.data;
  return useMemo(() => {
    if (!(ready && valueData)) {
      return NO_ROWS;
    }
    const byField = new Map(
      valueData.map((value) => [value.customFieldId, value] as const)
    );
    return fields.map((field) =>
      customFieldDetailsRow(field, byField.get(field.id), {
        entityId,
        entityType,
        itemLabel,
        loadReferenceOptions: referenceLoaders.get(field.id),
        onValueChange: (next) =>
          write(field, next, {
            people: people ?? [],
            referenceTargets: loadedTargets.current.get(field.id) ?? [],
          }),
        peopleOptions: people ?? [],
      })
    );
  }, [
    entityId,
    entityType,
    fields,
    itemLabel,
    people,
    ready,
    referenceLoaders,
    valueData,
    write,
  ]);
}

type EditorContext = {
  entityId: string;
  entityType: CustomFieldEntityType;
  itemLabel: string;
  loadReferenceOptions: LoadReferenceOptions | undefined;
  onValueChange: (next: CustomFieldTableValue) => Promise<unknown>;
  peopleOptions: readonly BasicUser[];
};

function customFieldDetailsRow(
  field: CustomFieldWithOptions,
  value: CustomFieldValueDetail | undefined,
  context: EditorContext
): DetailsField {
  const hasEditor =
    resolveCustomFieldEditor(field.fieldType) !== CustomFieldEditor.None;
  return {
    edit: hasEditor ? { mode: "self-saving" } : { mode: "read-only" },
    id: field.id,
    label: field.name,
    value: {
      empty: isCustomFieldValueEmpty(value),
      fill: MULTI_VALUE[field.fieldType],
      kind: "self-saving",
      render: (editable) =>
        editable ? (
          <CustomFieldDetailsEditor
            context={context}
            field={field}
            value={value}
          />
        ) : (
          renderCustomFieldTableValue(field, value)
        ),
    },
  };
}

/**
 * One custom field's editor on the Details tab, by its registry editor
 * (ISS-12302): typed fields and DATE use the Issue page's editors with
 * `inlineCommit`; ENUM, REFERENCE and the multi-value types use the Sessions
 * grid's cells, whose writes go through the optimistic, ordered write.
 */
function CustomFieldDetailsEditor({
  context,
  field,
  value,
}: Readonly<{
  context: EditorContext;
  field: CustomFieldWithOptions;
  value: CustomFieldValueDetail | undefined;
}>) {
  const editor = resolveCustomFieldEditor(field.fieldType);
  switch (editor) {
    case CustomFieldEditor.Scalar:
      return (
        <CustomFieldScalarEditor
          customField={field}
          entityId={context.entityId}
          entityType={context.entityType}
          inlineCommit
          surface={ArtifactStatusEditSurface.Detail}
          value={value}
        />
      );
    case CustomFieldEditor.Choice:
    case CustomFieldEditor.People:
    case CustomFieldEditor.Reference:
      return (
        <CustomFieldTableCell
          field={field}
          itemLabel={context.itemLabel}
          loadReferenceOptions={context.loadReferenceOptions}
          onValueChange={context.onValueChange}
          ownerEntityId={context.entityId}
          peopleOptions={context.peopleOptions}
          value={value}
        />
      );
    case CustomFieldEditor.None:
      return renderCustomFieldTableValue(field, value);
    default: {
      const unhandled: never = editor;
      return unhandled;
    }
  }
}

const NO_ROWS: readonly DetailsField[] = [];

/** The types whose cell fits a list of chips to its width, so it needs the row's. */
const MULTI_VALUE: Readonly<Record<CustomFieldType, boolean>> = {
  [CustomFieldType.Date]: false,
  [CustomFieldType.Enum]: false,
  [CustomFieldType.MultiEnum]: true,
  [CustomFieldType.Number]: false,
  [CustomFieldType.People]: true,
  [CustomFieldType.Reference]: false,
  [CustomFieldType.ReferenceMulti]: true,
  [CustomFieldType.Text]: false,
};
