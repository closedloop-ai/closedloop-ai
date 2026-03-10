"use client";

import type {
  AttachCustomFieldInput,
  CreateCustomFieldInput,
  CreateEnumOptionInput,
  CustomFieldEnumOption,
  CustomFieldSettingWithOptions,
  CustomFieldWithOptions,
  UpdateCustomFieldInput,
  UpdateEnumOptionInput,
} from "@repo/api/src/types/custom-field";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { artifactKeys } from "./use-artifacts";
import { issueKeys } from "./use-issues";
import { projectKeys } from "./use-projects";
import { workstreamKeys } from "./use-workstreams";

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
  entityType: CustomFieldEntityType
) {
  const query = useCustomFields();
  const filtered = (query.data ?? []).filter((f) =>
    (f.entityTypes ?? []).includes(entityType)
  );
  return { ...query, data: filtered };
}

export function useCustomField(
  id: string,
  options?: Omit<
    UseQueryOptions<CustomFieldWithOptions>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: customFieldKeys.detail(id),
    queryFn: () =>
      apiClient.get<CustomFieldWithOptions>(`/custom-fields/${id}`),
    enabled: !!id,
    ...options,
  });
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
        `/${entityType.toLowerCase()}s/${entityId}/custom-field-settings`
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

export function useDeleteCustomField() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/custom-fields/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customFieldKeys.all });
    },
  });
}

// Returns the entity detail query key for a given CustomFieldEntityType and entity ID.
function getEntityDetailKey(
  entityType: CustomFieldEntityType,
  entityId: string
): readonly unknown[] {
  if (entityType === CustomFieldEntityType.Project) {
    return projectKeys.detail(entityId);
  }
  if (entityType === CustomFieldEntityType.Workstream) {
    return workstreamKeys.detail(entityId);
  }
  if (entityType === CustomFieldEntityType.Issue) {
    return issueKeys.detail(entityId);
  }
  // Artifact
  return artifactKeys.detail(entityId);
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
        `/${entityType.toLowerCase()}s/${entityId}/custom-field-settings`,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.settings(entityType, entityId),
      });
      queryClient.invalidateQueries({
        queryKey: getEntityDetailKey(entityType, entityId),
      });
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
        `/${entityType.toLowerCase()}s/${entityId}/custom-field-settings/${customFieldId}`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: customFieldKeys.settings(entityType, entityId),
      });
      queryClient.invalidateQueries({
        queryKey: getEntityDetailKey(entityType, entityId),
      });
    },
  });
}

export function useUpdateCustomFieldValue(
  entityType: CustomFieldEntityType,
  entityId: string
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
      apiClient.put(`/${entityType.toLowerCase()}s/${entityId}`, {
        customFields: { [fieldId]: value },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: getEntityDetailKey(entityType, entityId),
      });
    },
  });
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
    },
  });
}
