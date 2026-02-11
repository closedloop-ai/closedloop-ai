"use client";

import type {
  CreateLoopRequest,
  CreateLoopResponse,
  Loop,
  LoopEvent,
  LoopListFilters,
  LoopWithUser,
  ResumeLoopRequest,
} from "@repo/api/src/types/loop";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const loopKeys = {
  all: ["loops"] as const,
  lists: () => [...loopKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...loopKeys.lists(), filters] as const,
  details: () => [...loopKeys.all, "detail"] as const,
  detail: (id: string) => [...loopKeys.details(), id] as const,
  events: (id: string) => [...loopKeys.detail(id), "events"] as const,
};

// Queries
export function useLoops(
  filters: LoopListFilters,
  options?: Omit<UseQueryOptions<LoopWithUser[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.list(filters),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) {
          params.set(key, value.toString());
        }
      }
      return apiClient.get<LoopWithUser[]>(`/loops?${params.toString()}`);
    },
    ...options,
  });
}

export function useLoop(
  id: string,
  options?: Omit<UseQueryOptions<Loop>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.detail(id),
    queryFn: () => apiClient.get<Loop>(`/loops/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useLoopEvents(
  loopId: string,
  options?: Omit<UseQueryOptions<LoopEvent[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.events(loopId),
    queryFn: () => apiClient.get<LoopEvent[]>(`/loops/${loopId}/events`),
    enabled: !!loopId,
    ...options,
  });
}

export function useLoopsByArtifact(
  artifactId: string,
  options?: Omit<UseQueryOptions<LoopWithUser[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.list({ artifactId }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("artifactId", artifactId);
      return apiClient.get<LoopWithUser[]>(`/loops?${params.toString()}`);
    },
    enabled: !!artifactId,
    ...options,
  });
}

// Mutations
export function useCreateLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateLoopRequest) =>
      apiClient.post<CreateLoopResponse>("/loops", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    },
  });
}

export function useCancelLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) => apiClient.delete<Loop>(`/loops/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: loopKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    },
  });
}

export function useResumeLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ id, ...body }: ResumeLoopRequest & { id: string }) =>
      apiClient.post<CreateLoopResponse>(`/loops/${id}/resume`, body),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: loopKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    },
  });
}
