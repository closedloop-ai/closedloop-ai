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
import { useApiClient } from "../../shared/api/use-api-client";

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
    queryFn: () =>
      apiClient.get<LinearIntegrationStatus>("/integrations/linear"),
    ...options,
  });
}

// Mutations
export function useExportToLinear() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      documentId,
      teamId,
    }: {
      documentId: string;
      teamId: string;
    }) =>
      apiClient.post<ExportToLinearResult>("/integrations/linear/export", {
        documentId,
        teamId,
      }),
  });
}

export function useDisconnectLinear() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.delete<{ disconnected: true }>("/integrations/linear"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linearKeys.status() });
    },
  });
}
