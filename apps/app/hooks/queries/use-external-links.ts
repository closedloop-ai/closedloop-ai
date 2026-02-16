"use client";

import type {
  CreateExternalLinkInput,
  ExternalLink,
  ExternalLinkType,
  FindExternalLinksOptions,
  UpdateExternalLinkInput,
} from "@repo/api/src/types/external-link";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { dashboardKeys } from "./use-dashboard-stats";

// Query keys
export const externalLinkKeys = {
  all: ["external-links"] as const,
  lists: () => [...externalLinkKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...externalLinkKeys.lists(), filters] as const,
  details: () => [...externalLinkKeys.all, "detail"] as const,
  detail: (id: string) => [...externalLinkKeys.details(), id] as const,
};

// Queries
export function useExternalLinks(
  searchParams: FindExternalLinksOptions,
  options?: Omit<UseQueryOptions<ExternalLink[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: externalLinkKeys.list(searchParams),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        if (value !== undefined) {
          params.set(key, value.toString());
        }
      }
      return apiClient.get<ExternalLink[]>(
        `/external-links?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useExternalLinksByWorkstream(
  workstreamId: string,
  type?: ExternalLinkType,
  options?: Omit<UseQueryOptions<ExternalLink[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: externalLinkKeys.list({ workstreamId, type }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("workstreamId", workstreamId);
      if (type) {
        params.set("type", type);
      }
      return apiClient.get<ExternalLink[]>(
        `/external-links?${params.toString()}`
      );
    },
    enabled: !!workstreamId,
    ...options,
  });
}

// Mutations
export function useCreateExternalLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateExternalLinkInput) =>
      apiClient.post<ExternalLink>("/external-links", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: externalLinkKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
    },
  });
}

export function useUpdateExternalLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateExternalLinkInput) => {
      const { id, ...body } = input;
      return apiClient.put<ExternalLink>(`/external-links/${id}`, body);
    },
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({
        queryKey: externalLinkKeys.detail(input.id),
      });
      queryClient.invalidateQueries({ queryKey: externalLinkKeys.lists() });
    },
  });
}

export function useDeleteExternalLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/external-links/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: externalLinkKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
    },
  });
}
