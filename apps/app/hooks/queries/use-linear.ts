"use client";

import type {
  ExportToLinearResult,
  LinearIntegrationStatus,
} from "@repo/api/src/types/linear";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const linearKeys = {
  all: ["linear"] as const,
  status: () => [...linearKeys.all, "status"] as const,
};

// Queries
export function useLinearIntegrationStatus(
  options?: Omit<
    UseQueryOptions<LinearIntegrationStatus>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: linearKeys.status(),
    queryFn: () => apiClient.get<LinearIntegrationStatus>("/linear/status"),
    ...options,
  });
}

// Mutations
export function useExportToLinear() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      artifactId,
      teamId,
    }: {
      artifactId: string;
      teamId: string;
    }) =>
      apiClient.post<ExportToLinearResult>("/linear/export", {
        artifactId,
        teamId,
      }),
  });
}

export function useDisconnectLinear() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.post<{ success: true }>("/linear/disconnect", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linearKeys.status() });
    },
  });
}

/**
 * Get the Linear OAuth URL for connecting.
 * This is a simple fetch that returns the URL string.
 */
export function useGetLinearOAuthUrl() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () => apiClient.get<{ url: string }>("/linear/oauth-url"),
  });
}
