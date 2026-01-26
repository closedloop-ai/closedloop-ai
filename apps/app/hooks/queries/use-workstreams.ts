"use client";

import type {
  CreateWorkstreamInput,
  UpdateWorkstreamInput,
  Workstream,
  WorkstreamWithProject,
} from "@repo/api/src/types/workstream";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const workstreamKeys = {
  all: ["workstreams"] as const,
  lists: () => [...workstreamKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...workstreamKeys.lists(), filters] as const,
  details: () => [...workstreamKeys.all, "detail"] as const,
  detail: (id: string) => [...workstreamKeys.details(), id] as const,
};

// Queries
export function useWorkstreams(
  projectId?: string,
  options?: Omit<
    UseQueryOptions<WorkstreamWithProject[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: workstreamKeys.list({ projectId }),
    queryFn: () => {
      const params = new URLSearchParams();
      if (projectId) {
        params.set("projectId", projectId);
      }
      const query = params.toString();
      return apiClient.get<WorkstreamWithProject[]>(
        `/workstreams${query ? `?${query}` : ""}`
      );
    },
    ...options,
  });
}

export function useRecentWorkstreams(
  limit = 6,
  options?: Omit<
    UseQueryOptions<WorkstreamWithProject[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: workstreamKeys.list({ recent: true, limit }),
    queryFn: () =>
      apiClient.get<WorkstreamWithProject[]>(`/workstreams?limit=${limit}`),
    ...options,
  });
}

export function useSearchWorkstreams(
  query: string,
  options?: Omit<
    UseQueryOptions<WorkstreamWithProject[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: workstreamKeys.list({ search: query }),
    queryFn: () =>
      apiClient.get<WorkstreamWithProject[]>(
        `/workstreams?search=${encodeURIComponent(query)}`
      ),
    enabled: !!query,
    ...options,
  });
}

export function useWorkstream(
  id: string,
  options?: Omit<UseQueryOptions<Workstream>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: workstreamKeys.detail(id),
    queryFn: () => apiClient.get<Workstream>(`/workstreams/${id}`),
    enabled: !!id,
    ...options,
  });
}

// Mutations
export function useCreateWorkstream() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateWorkstreamInput) =>
      apiClient.post<Workstream>("/workstreams", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workstreamKeys.lists() });
    },
  });
}

export function useUpdateWorkstream() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateWorkstreamInput) => {
      const { id, ...body } = input;
      return apiClient.put<Workstream>(`/workstreams/${id}`, body);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: workstreamKeys.detail(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: workstreamKeys.lists() });
    },
  });
}

export function useDeleteWorkstream() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/workstreams/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workstreamKeys.lists() });
    },
  });
}
