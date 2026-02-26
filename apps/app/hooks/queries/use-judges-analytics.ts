"use client";

import type {
  ArtifactCountsGroupBy as ArtifactCountsGroupByType,
  ArtifactCountsResponse,
  JudgeStatsResponse,
} from "@repo/api/src/types/judges-analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export type { ArtifactCountsGroupBy } from "@repo/api/src/types/judges-analytics";

// Query keys
export const judgesAnalyticsKeys = {
  all: ["judges-analytics"] as const,
  dateRange: (startDate: string, endDate: string) =>
    [...judgesAnalyticsKeys.all, startDate, endDate] as const,
  artifactCounts: (
    startDate: string,
    endDate: string,
    groupBy: ArtifactCountsGroupByType
  ) =>
    [
      ...judgesAnalyticsKeys.all,
      "artifact-counts",
      startDate,
      endDate,
      groupBy,
    ] as const,
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

export function useArtifactCounts(
  startDate: string,
  endDate: string,
  groupBy: ArtifactCountsGroupByType,
  options?: Omit<
    UseQueryOptions<ArtifactCountsResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: judgesAnalyticsKeys.artifactCounts(startDate, endDate, groupBy),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("startDate", startDate);
      params.set("endDate", endDate);
      params.set("groupBy", groupBy);
      return apiClient.get<ArtifactCountsResponse>(
        `/judges-analytics/artifact-counts?${params.toString()}`
      );
    },
    enabled: !!startDate && !!endDate && !!groupBy,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
