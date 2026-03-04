"use client";

import type { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type {
  ArtifactCountsGroupBy as ArtifactCountsGroupByType,
  ArtifactCountsResponse,
  JudgeDetailResponse,
  JudgeStatsResponse,
} from "@repo/api/src/types/judges-analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export type { ArtifactCountsGroupBy } from "@repo/api/src/types/judges-analytics";

// Query keys
export const judgesAnalyticsKeys = {
  all: ["judges-analytics"] as const,
  dateRange: (
    startDate: string,
    endDate: string,
    reportType: EvaluationReportType
  ) => [...judgesAnalyticsKeys.all, startDate, endDate, reportType] as const,
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
  detail: (promptName: string, reportType: EvaluationReportType) =>
    [...judgesAnalyticsKeys.all, "detail", promptName, reportType] as const,
};

// Query hook
export function useJudgesAnalytics(
  startDate: string,
  endDate: string,
  reportType: EvaluationReportType,
  options?: Omit<UseQueryOptions<JudgeStatsResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: judgesAnalyticsKeys.dateRange(startDate, endDate, reportType),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("startDate", startDate);
      params.set("endDate", endDate);
      params.set("reportType", reportType);
      return apiClient.get<JudgeStatsResponse>(
        `/judges-analytics?${params.toString()}`
      );
    },
    enabled: !!startDate && !!endDate && !!reportType,
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

export function useJudgeDetail(
  promptName: string,
  reportType: EvaluationReportType,
  options?: Omit<UseQueryOptions<JudgeDetailResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: judgesAnalyticsKeys.detail(promptName, reportType),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("reportType", reportType);
      return apiClient.get<JudgeDetailResponse>(
        `/judges-analytics/${encodeURIComponent(promptName)}?${params.toString()}`
      );
    },
    enabled: Boolean(promptName) && Boolean(reportType),
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
