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
  artifactId: string | undefined,
  options?: Omit<UseQueryOptions<PerfSummary | null>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: performanceKeys.detail(artifactId ?? ""),
    queryFn: () =>
      apiClient.get<PerfSummary | null>(`/artifacts/${artifactId}/perf`),
    enabled: !!artifactId,
    staleTime: 10 * 60 * 1000, // 10 minutes
    retry: false,
    ...options,
  });
}
