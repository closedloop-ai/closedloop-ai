"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type CreateCustomFieldInput,
  type CustomFieldEntityType,
  type CustomFieldReferenceSearchResponse,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import type { CustomFieldTableValue } from "@repo/app/custom-fields/components/custom-field-table-cell";
import {
  useCreateCustomField,
  useCustomFieldReferenceTargetSearch,
  useCustomFields,
  useUpdateCustomField,
  useUpdateCustomFieldValueForEntityType,
} from "@repo/app/custom-fields/hooks/use-custom-fields";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import {
  type QueryClient,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useRef } from "react";

/**
 * ISS-12663 — one list surface's custom-field columns: the org's field
 * definitions for `entityType`, each row's values, and the writes behind Add
 * field and a cell edit.
 *
 * Extracted from the Sessions list's controller so the Branches list attaches
 * custom fields through the same definitions, permissions, editors and
 * persistence rather than a parallel path. Sessions keeps its own row-shaped
 * controller as a thin adapter over this one.
 */
export type EntityListCustomFieldsController = {
  /** Org fields that apply to this entity type and show in the table. */
  fields: readonly CustomFieldWithOptions[];
  /** Org fields the reader may attach to this list through Add field. */
  availableFields?: readonly CustomFieldWithOptions[];
  valuesByEntityId: ReadonlyMap<string, readonly CustomFieldValueDetail[]>;
  peopleOptions?: readonly BasicUser[];
  onCreateField?: (
    input: CreateCustomFieldInput
  ) => Promise<CustomFieldWithOptions> | CustomFieldWithOptions;
  onAddExistingField?: (fieldId: string) => Promise<void> | void;
  onValueChange?: (
    entityId: string,
    field: CustomFieldWithOptions,
    value: CustomFieldTableValue
  ) => Promise<void> | void;
  searchReferenceTargets?: (
    field: CustomFieldWithOptions,
    entityId: string,
    query: string
  ) => Promise<CustomFieldReferenceSearchResponse>;
};

/**
 * One list row as this controller reads it. `customFields` is OPTIONAL and its
 * absence is meaningful: a version-skewed or local producer that did not load
 * the projection omits it, and the controller is then withheld rather than
 * presenting every row as having no values.
 */
export type EntityListCustomFieldsItem = Readonly<{
  entityId: string;
  customFields?: readonly CustomFieldValueDetail[];
}>;

export function useEntityListCustomFieldsController({
  enabled = true,
  entityType,
  invalidateQueryKeys,
  items,
  queryClient: listQueryClient,
}: {
  enabled?: boolean;
  entityType: CustomFieldEntityType;
  /** The list reads a value write has to refresh. */
  invalidateQueryKeys: readonly QueryKey[];
  items: readonly EntityListCustomFieldsItem[];
  /**
   * The client the list's reads live in, when the list owns one (the Branches
   * list can inject a Branch-only client); defaults to the ambient client.
   */
  queryClient?: QueryClient;
}): EntityListCustomFieldsController | undefined {
  // `items.length === 0` is otherwise vacuously true, which would fire
  // `useCustomFields` on an empty list regardless of `enabled` — the case a
  // host gating this hook on its own mode (ISS-12455's desktop local mode) is
  // relying on this flag to prevent.
  const valuesAvailable =
    enabled &&
    (items.length === 0 ||
      items.every((item) => Object.hasOwn(item, "customFields")));
  const definitions = useCustomFields({ enabled: valuesAvailable });
  const definitionData = Array.isArray(definitions.data)
    ? definitions.data
    : EMPTY_CUSTOM_FIELD_DEFINITIONS;
  const definitionsAvailable = Array.isArray(definitions.data);
  const fields = useMemo(
    () =>
      definitionData.filter((field) => field.entityTypes.includes(entityType)),
    [definitionData, entityType]
  );
  const availableFields = useMemo(
    () =>
      definitionData.filter(
        (field) =>
          !(field.entityTypes.includes(entityType) && field.showInTable)
      ),
    [definitionData, entityType]
  );
  const valuesByEntityId = useMemo(
    () =>
      new Map(
        items.map((item) => [item.entityId, item.customFields ?? []] as const)
      ),
    [items]
  );
  const { mutateAsync: createField } = useCreateCustomField();
  const { mutateAsync: updateField } = useUpdateCustomField();
  const { mutateAsync: updateValue } = useUpdateCustomFieldValueForEntityType(
    entityType,
    ArtifactStatusEditSurface.InlineCell
  );
  const searchReferenceTargets = useCustomFieldReferenceTargetSearch();
  /**
   * codex review cid 3884184666: the tail of the value-write chain.
   *
   * Each cell edit is a WHOLE-VALUE `PUT`, so two of them in flight at once are
   * decided by arrival order rather than by click order — a multi-enum cell
   * clicked twice quickly could commit the earlier selection last and leave the
   * table showing a value the reader never chose. Chaining makes click order the
   * commit order.
   *
   * The stored promise is the SETTLED one, so a rejected write does not wedge
   * the queue for the rest of the mount; the rejection itself still propagates
   * to the caller through the promise this handler returns.
   */
  const valueWriteChain = useRef<Promise<unknown>>(Promise.resolve());
  const needsPeopleOptions = fields.some(
    (field) => field.fieldType === CustomFieldType.People
  );
  const { data: organizationUsers } = useOrganizationUsers({
    enabled: valuesAvailable && definitionsAvailable && needsPeopleOptions,
  });
  const ambientQueryClient = useQueryClient();
  const queryClient = listQueryClient ?? ambientQueryClient;

  return useMemo(() => {
    if (!(valuesAvailable && definitionsAvailable)) {
      return undefined;
    }

    return {
      fields,
      availableFields,
      valuesByEntityId,
      peopleOptions: organizationUsers,
      onCreateField: createField,
      onAddExistingField: async (fieldId) => {
        const field = availableFields.find(
          (candidate) => candidate.id === fieldId
        );
        if (!field) {
          return;
        }
        await updateField({
          id: field.id,
          entityTypes: field.entityTypes.includes(entityType)
            ? field.entityTypes
            : [...field.entityTypes, entityType],
          showInTable: true,
        });
      },
      onValueChange: (entityId, field, value) => {
        const write = valueWriteChain.current.then(async () => {
          await updateValue({ entityId, fieldId: field.id, value });
          await Promise.all(
            invalidateQueryKeys.map((queryKey) =>
              queryClient.invalidateQueries({ queryKey })
            )
          );
        });
        valueWriteChain.current = write.catch(() => undefined);
        return write;
      },
      searchReferenceTargets: (field, entityId, query) =>
        searchReferenceTargets(field.id, query, entityId),
    };
  }, [
    availableFields,
    createField,
    definitionsAvailable,
    entityType,
    fields,
    invalidateQueryKeys,
    organizationUsers,
    queryClient,
    searchReferenceTargets,
    updateField,
    updateValue,
    valuesAvailable,
    valuesByEntityId,
  ]);
}

const EMPTY_CUSTOM_FIELD_DEFINITIONS: readonly CustomFieldWithOptions[] = [];
