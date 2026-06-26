"use client";

import type {
  ApplyTagInput,
  BatchApplyTagInput,
  CreateTagInput,
  Tag,
  UpdateTagInput,
} from "@repo/api/src/types/tag";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { documentKeys } from "../../documents/hooks/document-keys";
import { loopKeys } from "../../loops/hooks/loop-keys";
import { projectKeys } from "../../projects/hooks/project-keys";
import { useApiClient } from "../../shared/api/use-api-client";

export const tagKeys = {
  all: ["tags"] as const,
  lists: () => [...tagKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...tagKeys.lists(), filters] as const,
  details: () => [...tagKeys.all, "detail"] as const,
  detail: (id: string) => [...tagKeys.details(), id] as const,
};

export function useTags(
  options?: Omit<UseQueryOptions<Tag[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: tagKeys.list({}),
    queryFn: () => apiClient.get<Tag[]>("/tags"),
    ...options,
  });
}

export function useCreateTag() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateTagInput) => apiClient.post<Tag>("/tags", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.lists() });
    },
  });
}

export function useUpdateTag() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTagInput & { id: string }) =>
      apiClient.patch<Tag>(`/tags/${id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.lists() });
      invalidateEntityQueries(queryClient);
    },
  });
}

export function useDeleteTag() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/tags/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.lists() });
      invalidateEntityQueries(queryClient);
    },
  });
}

export function useApplyTag() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: ApplyTagInput) =>
      apiClient.post<{ applied: boolean }>("/entity-tags", input),
    onSuccess: () => {
      invalidateEntityQueries(queryClient);
    },
  });
}

export function useRemoveTag() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: ApplyTagInput) => {
      const params = new URLSearchParams({
        tagId: input.tagId,
        entityType: input.entityType,
        entityId: input.entityId,
      });
      return apiClient.delete(`/entity-tags?${params.toString()}`);
    },
    onSuccess: () => {
      invalidateEntityQueries(queryClient);
    },
  });
}

export function useBatchApplyTag() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ tagId, entityType, entityIds }: BatchApplyTagInput) =>
      apiClient.post<{ appliedCount: number }>("/entity-tags/batch", {
        tagId,
        entityType,
        entityIds,
      }),
    onSuccess: () => {
      invalidateEntityQueries(queryClient);
    },
  });
}

function invalidateEntityQueries(
  queryClient: ReturnType<typeof useQueryClient>
) {
  queryClient.invalidateQueries({ queryKey: projectKeys.all });
  queryClient.invalidateQueries({ queryKey: documentKeys.all });
  queryClient.invalidateQueries({ queryKey: loopKeys.all });
}
