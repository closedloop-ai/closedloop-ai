"use client";

import type {
  AgentDetail,
  AgentListResponse,
  AgentVersionDetail,
  AgentVersionSummary,
  CreateAgentRequest,
  UpdateAgentRequest,
} from "@repo/api/src/types/agent";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { buildSearchParams } from "@/lib/format-utils";

export const agentKeys = {
  all: ["agents"] as const,
  lists: () => [...agentKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...agentKeys.lists(), filters] as const,
  details: () => [...agentKeys.all, "detail"] as const,
  detail: (idOrSlug: string) => [...agentKeys.details(), idOrSlug] as const,
  versions: (idOrSlug: string) =>
    [...agentKeys.detail(idOrSlug), "versions"] as const,
  version: (idOrSlug: string, version: number) =>
    [...agentKeys.versions(idOrSlug), version] as const,
};

export function useAgents(
  filters: { enabled?: string; search?: string } = {},
  options?: Omit<UseQueryOptions<AgentListResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: agentKeys.list(filters),
    queryFn: () => {
      const params = buildSearchParams(filters);
      return apiClient.get<AgentListResponse>(`/agents?${params.toString()}`);
    },
    ...options,
  });
}

export function useAgent(
  idOrSlug: string,
  options?: Omit<UseQueryOptions<AgentDetail>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: agentKeys.detail(idOrSlug),
    queryFn: () => apiClient.get<AgentDetail>(`/agents/${idOrSlug}`),
    enabled: !!idOrSlug,
    ...options,
  });
}

export function useUpdateAgent(idOrSlug: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (data: UpdateAgentRequest) =>
      apiClient.patch<AgentDetail>(`/agents/${idOrSlug}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(idOrSlug) });
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (idOrSlug: string) => apiClient.delete(`/agents/${idOrSlug}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}

export function useCreateAgent() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (data: CreateAgentRequest) =>
      apiClient.post<AgentDetail>("/agents", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}

export function useAgentVersions(
  idOrSlug: string,
  options?: Omit<
    UseQueryOptions<{ versions: AgentVersionSummary[] }>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: agentKeys.versions(idOrSlug),
    queryFn: () =>
      apiClient.get<{ versions: AgentVersionSummary[] }>(
        `/agents/${idOrSlug}/versions`
      ),
    enabled: !!idOrSlug,
    ...options,
  });
}

export function useAgentVersion(
  idOrSlug: string,
  version: number,
  options?: Omit<UseQueryOptions<AgentVersionDetail>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: agentKeys.version(idOrSlug, version),
    queryFn: () =>
      apiClient.get<AgentVersionDetail>(
        `/agents/${idOrSlug}/versions/${version}`
      ),
    enabled: !!idOrSlug && version > 0,
    ...options,
  });
}
