"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type {
  AttachCustomFieldInput,
  CreateCustomFieldInput,
  CreateEnumOptionInput,
  CustomFieldEnumOption,
  CustomFieldReferenceSearchResponse,
  CustomFieldSettingWithOptions,
  CustomFieldWithOptions,
  UpdateCustomFieldInput,
  UpdateEnumOptionInput,
} from "@repo/api/src/types/custom-field";
import {
  CUSTOM_FIELD_ENTITY_API_SEGMENT,
  CustomFieldEntityType,
} from "@repo/api/src/types/custom-field";
// Cross-slice: custom fields attach to documents and projects, so field
// definition/value mutations invalidate those entities' query caches.
import { invalidateDocumentCustomFieldWriteViewFamilies } from "@repo/app/documents/hooks/bulk-artifact-invalidation";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { buildSearchParams } from "@repo/app/shared/lib/format-utils";
import {
  type MutationToastOptions,
  mutationToastMeta,
} from "@repo/app/shared/query/query-client";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";

// Query keys
export const customFieldKeys = {
  all: ["custom-fields"] as const,
  lists: () => [...customFieldKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...customFieldKeys.lists(), filters] as const,
  details: () => [...customFieldKeys.all, "detail"] as const,
  detail: (id: string) => [...customFieldKeys.details(), id] as const,
  enumOptions: (fieldId: string) =>
    [...customFieldKeys.detail(fieldId), "enum-options"] as const,
  settings: (entityType: CustomFieldEntityType, entityId: string) =>
    [...customFieldKeys.all, "settings", entityType, entityId] as const,
  values: (entityType: CustomFieldEntityType, entityId: string) =>
    [...customFieldKeys.all, "values", entityType, entityId] as const,
};

// Queries

export function useCustomFields(
  options?: Omit<
    UseQueryOptions<CustomFieldWithOptions[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: customFieldKeys.list({}),
    queryFn: () => apiClient.get<CustomFieldWithOptions[]>("/custom-fields"),
    ...options,
  });
}

/**
 * Returns custom fields that have the given entity type in their entityTypes array.
 * Filters client-side from the org-scoped list (small dataset, avoids extra endpoint).
 */
export function useCustomFieldsForEntityType(
  entityType: CustomFieldEntityType,
  options?: { enabled?: boolean }
) {
  const query = useCustomFields(options);
  const filtered = (query.data ?? []).filter((f) =>
    (f.entityTypes ?? []).includes(entityType)
  );
  return { ...query, data: filtered };
}

export function useCustomFieldEnumOptions(
  fieldId: string,
  options?: Omit<
    UseQueryOptions<CustomFieldEnumOption[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: customFieldKeys.enumOptions(fieldId),
    queryFn: () =>
      apiClient.get<CustomFieldEnumOption[]>(
        `/custom-fields/${fieldId}/enum-options`
      ),
    enabled: !!fieldId,
    ...options,
  });
}

export function useCustomFieldSettings(
  entityType: CustomFieldEntityType,
  entityId: string,
  options?: Omit<
    UseQueryOptions<CustomFieldSettingWithOptions[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: customFieldKeys.settings(entityType, entityId),
    queryFn: () =>
      apiClient.get<CustomFieldSettingWithOptions[]>(
        `/${CUSTOM_FIELD_ENTITY_API_SEGMENT[entityType]}/${entityId}/custom-field-settings`
      ),
    enabled: !!entityType && !!entityId,
    ...options,
  });
}

// Mutations

export function useCreateCustomField() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateCustomFieldInput) =>
      apiClient.post<CustomFieldWithOptions>("/custom-fields", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customFieldKeys.lists() });
    },
  });
}

export function useUpdateCustomField() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateCustomFieldInput) => {
      const { id, ...data } = input;
      return apiClient.put<CustomFieldWithOptions>(
        `/custom-fields/${id}`,
        data
      );
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: customFieldKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.detail(result.id),
      });
    },
  });
}

export function useDeleteCustomField(options?: Readonly<MutationToastOptions>) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: mutationToastMeta(options),
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/custom-fields/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customFieldKeys.all });
    },
  });
}

/**
 * The entity detail query key whose cache a custom-field write invalidates, or
 * `null` when this entity type has no detail cache carrying custom fields.
 *
 * Sessions and Branches return `null` deliberately: their detail responses do
 * not embed `customFields` (ISS-7209 gave them a separate values sub-resource
 * instead), so there is nothing to invalidate. Returning a documents key for
 * them — which is what the old `if Project … else documents` shape did — would
 * evict an unrelated document from cache and still miss the real one.
 */
function getEntityDetailKey(
  entityType: CustomFieldEntityType,
  entityId: string
): readonly unknown[] | null {
  switch (entityType) {
    case CustomFieldEntityType.Project:
      return projectKeys.detail(entityId);
    case CustomFieldEntityType.Document:
      return documentKeys.detail(entityId);
    case CustomFieldEntityType.Session:
    case CustomFieldEntityType.Branch:
      return null;
    default: {
      // Adding an entity type must fail typecheck here rather than silently
      // resolve to "no cache to invalidate", which reads as a working write
      // whose stale detail view never refreshes.
      const exhaustive: never = entityType;
      return exhaustive;
    }
  }
}

export function useAttachCustomField(
  entityType: CustomFieldEntityType,
  entityId: string
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: AttachCustomFieldInput) =>
      apiClient.post<CustomFieldSettingWithOptions>(
        `/${CUSTOM_FIELD_ENTITY_API_SEGMENT[entityType]}/${entityId}/custom-field-settings`,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.settings(entityType, entityId),
      });
      invalidateEntityDetail(queryClient, entityType, entityId);
    },
  });
}

export function useDetachCustomField(
  entityType: CustomFieldEntityType,
  entityId: string
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (customFieldId: string) =>
      apiClient.delete<{ deleted: true }>(
        `/${CUSTOM_FIELD_ENTITY_API_SEGMENT[entityType]}/${entityId}/custom-field-settings/${customFieldId}`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.settings(entityType, entityId),
      });
      invalidateEntityDetail(queryClient, entityType, entityId);
    },
  });
}

export function useUpdateCustomFieldValue(
  entityType: CustomFieldEntityType,
  entityId: string,
  surface?: ArtifactStatusEditSurface
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      fieldId,
      value,
    }: {
      fieldId: string;
      value: string | number | string[] | null;
    }) =>
      putCustomFieldValue(
        apiClient,
        entityType,
        entityId,
        fieldId,
        value,
        surface
      ),
    // The entity is captured at mutate time: a rerender with another entity
    // must not end a different entity's count.
    onMutate: () => {
      beginCustomFieldValueWrite(queryClient, entityType, entityId);
      return { entityId, entityType };
    },
    onSettled: (_result, _error, _variables, written) => {
      if (written) {
        endCustomFieldValueWrite(
          queryClient,
          written.entityType,
          written.entityId
        );
      }
    },
  });
}

export function useUpdateCustomFieldValueForEntityType(
  entityType: CustomFieldEntityType,
  surface?: ArtifactStatusEditSurface
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      entityId,
      fieldId,
      value,
    }: {
      entityId: string;
      fieldId: string;
      value: string | number | string[] | null;
    }) =>
      putCustomFieldValue(
        apiClient,
        entityType,
        entityId,
        fieldId,
        value,
        surface
      ),
    onSuccess: (_result, { entityId }) => {
      invalidateCustomFieldValueReads(queryClient, entityType, entityId);
    },
  });
}

export function useCustomFieldReferenceTargetSearch() {
  const apiClient = useApiClient();

  return useCallback(
    (fieldId: string, query: string, excludeEntityId?: string) => {
      const search = buildSearchParams({ query, excludeEntityId }).toString();
      return apiClient.get<CustomFieldReferenceSearchResponse>(
        `/custom-fields/${fieldId}/reference-targets?${search}`
      );
    },
    [apiClient]
  );
}

export function useCreateEnumOption(fieldId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateEnumOptionInput) =>
      apiClient.post<CustomFieldEnumOption>(
        `/custom-fields/${fieldId}/enum-options`,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.detail(fieldId),
      });
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.lists(),
      });
    },
  });
}

export function useUpdateEnumOption(fieldId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      optionId,
      ...data
    }: UpdateEnumOptionInput & { optionId: string }) =>
      apiClient.put<CustomFieldEnumOption>(
        `/custom-fields/${fieldId}/enum-options/${optionId}`,
        data
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.detail(fieldId),
      });
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.lists(),
      });
    },
  });
}

export function useReorderEnumOptions(fieldId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (optionIds: string[]) =>
      apiClient.post(`/custom-fields/${fieldId}/enum-options/reorder`, {
        optionIds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.detail(fieldId),
      });
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.enumOptions(fieldId),
      });
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.lists(),
      });
    },
  });
}

/**
 * Whether this entity type writes its custom field values through the dedicated
 * `custom-field-values` sub-resource rather than its own entity PUT body.
 *
 * Exhaustive so a new entity type has to state which write shape it uses; the
 * server mounts only one of the two per type, and picking wrong is a 405.
 */
function hasEntityValueSubresource(entityType: CustomFieldEntityType): boolean {
  switch (entityType) {
    case CustomFieldEntityType.Session:
    case CustomFieldEntityType.Branch:
      return true;
    case CustomFieldEntityType.Project:
    case CustomFieldEntityType.Document:
      return false;
    default: {
      // Adding an entity type must fail typecheck here rather than silently
      // default to the entity PUT body, which the server does not mount for a
      // type that has a values sub-resource — every value write would 405.
      const exhaustive: never = entityType;
      return exhaustive;
    }
  }
}

/** Invalidates an entity's detail cache, when it has one carrying custom fields. */
function invalidateEntityDetail(
  queryClient: ReturnType<typeof useQueryClient>,
  entityType: CustomFieldEntityType,
  entityId: string
): void {
  const queryKey = getEntityDetailKey(entityType, entityId);
  if (queryKey) {
    queryClient.invalidateQueries({ queryKey });
  }
}

/** Writes one custom field value on one entity, through the route its type mounts. */
export function putCustomFieldValue(
  apiClient: ReturnType<typeof useApiClient>,
  entityType: CustomFieldEntityType,
  entityId: string,
  fieldId: string,
  value: string | number | string[] | null,
  surface?: ArtifactStatusEditSurface
) {
  const segment = CUSTOM_FIELD_ENTITY_API_SEGMENT[entityType];
  // Projects and Documents carry their values in their own PUT body; they
  // have a mutable representation to hang them off. Sessions and Branches
  // do not, so ISS-7209 gave them a dedicated values sub-resource — writing
  // one through the entity PUT would 405, since neither route accepts one.
  if (hasEntityValueSubresource(entityType)) {
    return apiClient.put(
      `/${segment}/${entityId}/custom-field-values/${fieldId}`,
      { value, ...(surface === undefined ? {} : { surface }) }
    );
  }
  return apiClient.put(`/${segment}/${entityId}`, {
    customFields: { [fieldId]: value },
    ...(surface === undefined ? {} : { surface }),
  });
}

/** Refetches what a custom field value write changes: the values and the entity detail. */
export function invalidateCustomFieldValueReads(
  queryClient: ReturnType<typeof useQueryClient>,
  entityType: CustomFieldEntityType,
  entityId: string
): void {
  queryClient.invalidateQueries({
    queryKey: customFieldKeys.values(entityType, entityId),
  });
  invalidateEntityDetail(queryClient, entityType, entityId);
  if (entityType === CustomFieldEntityType.Document) {
    invalidateDocumentCustomFieldWriteViewFamilies(queryClient);
  }
}

/**
 * Counts one more value write in flight on an entity; each is ended by
 * {@link endCustomFieldValueWrite}. The Details tab's typed and menu editors
 * share this count (ISS-12302), so a read cannot land while either path still
 * has a write queued and replace that write's optimistic value.
 */
export function beginCustomFieldValueWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  entityType: CustomFieldEntityType,
  entityId: string
): void {
  let counts = valueWritesInFlight.get(queryClient);
  if (!counts) {
    counts = new Map();
    valueWritesInFlight.set(queryClient, counts);
  }
  const key = valueWriteKey(entityType, entityId);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Ends one value write; the last one out reads the entity's values again. */
export function endCustomFieldValueWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  entityType: CustomFieldEntityType,
  entityId: string
): void {
  const counts = valueWritesInFlight.get(queryClient);
  const key = valueWriteKey(entityType, entityId);
  const remaining = (counts?.get(key) ?? 1) - 1;
  if (remaining > 0) {
    counts?.set(key, remaining);
    return;
  }
  counts?.delete(key);
  invalidateCustomFieldValueReads(queryClient, entityType, entityId);
}

function valueWriteKey(
  entityType: CustomFieldEntityType,
  entityId: string
): string {
  return `${entityType}:${entityId}`;
}

// An entity's entry leaves when its count reaches zero, so each client holds
// only the entities with a write in flight.
const valueWritesInFlight = new WeakMap<
  ReturnType<typeof useQueryClient>,
  Map<string, number>
>();
