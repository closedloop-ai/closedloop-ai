"use client";

import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const executionLogKeys = {
  all: ["execution-log"] as const,
  detail: (documentId: string) =>
    [...executionLogKeys.all, documentId] as const,
};

// Query hook
export function useExecutionLog(
  documentId: string,
  options?: Omit<UseQueryOptions<ExecutionTrace>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: executionLogKeys.detail(documentId),
    queryFn: () =>
      apiClient.get<ExecutionTrace>(`/documents/${documentId}/execution-log`),
    enabled: !!documentId,
    staleTime: 10 * 60 * 1000, // 10 minutes
    ...options,
  });
}
