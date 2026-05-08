"use client";

import type { PerfSummary } from "@repo/api/src/types/performance";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const performanceKeys = {
  all: ["performance"] as const,
  detail: (id: string) => [...performanceKeys.all, "detail", id] as const,
};

// Query hook
export function usePerformanceData(
  documentId: string | undefined,
  options?: Omit<UseQueryOptions<PerfSummary | null>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: performanceKeys.detail(documentId ?? ""),
    queryFn: () =>
      apiClient.get<PerfSummary | null>(`/documents/${documentId}/perf`),
    enabled: !!documentId,
    staleTime: 10 * 60 * 1000, // 10 minutes
    retry: false,
    ...options,
  });
}
