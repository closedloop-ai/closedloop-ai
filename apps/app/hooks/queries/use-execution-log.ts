"use client";

import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const executionLogKeys = {
  all: ["execution-log"] as const,
  detail: (artifactId: string) =>
    [...executionLogKeys.all, artifactId] as const,
};

// Query hook
export function useExecutionLog(
  artifactId: string,
  options?: Omit<UseQueryOptions<ExecutionTrace>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: executionLogKeys.detail(artifactId),
    queryFn: () =>
      apiClient.get<ExecutionTrace>(`/artifacts/${artifactId}/execution-log`),
    enabled: !!artifactId,
    staleTime: 10 * 60 * 1000, // 10 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => {
      // Skip retries for 404 (execution log doesn't exist yet)
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 404
      ) {
        return false;
      }
      // Retry max 2 times for other errors
      return failureCount < 2;
    },
    ...options,
  });
}
