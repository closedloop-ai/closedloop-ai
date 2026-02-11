"use client";

import type { JudgeStatsResponse } from "@repo/api/src/types/judges-analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const judgesAnalyticsKeys = {
  all: ["judges-analytics"] as const,
  dateRange: (startDate: string, endDate: string) =>
    [...judgesAnalyticsKeys.all, startDate, endDate] as const,
};

// Query hook
export function useJudgesAnalytics(
  startDate: string,
  endDate: string,
  options?: Omit<UseQueryOptions<JudgeStatsResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: judgesAnalyticsKeys.dateRange(startDate, endDate),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("startDate", startDate);
      params.set("endDate", endDate);
      return apiClient.get<JudgeStatsResponse>(
        `/judges-analytics?${params.toString()}`
      );
    },
    enabled: !!startDate && !!endDate,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
