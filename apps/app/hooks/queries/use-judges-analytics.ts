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
import { JUDGES_ANALYTICS_QUERY_STALE_TIME_MS } from "@/lib/config/judges-analytics";

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
  detail: (metricName: string, reportType: EvaluationReportType) =>
    [...judgesAnalyticsKeys.all, "detail", metricName, reportType] as const,
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
    staleTime: JUDGES_ANALYTICS_QUERY_STALE_TIME_MS,
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
    staleTime: JUDGES_ANALYTICS_QUERY_STALE_TIME_MS,
    ...options,
  });
}

export function useJudgeDetail(
  metricName: string,
  reportType: EvaluationReportType,
  options?: Omit<UseQueryOptions<JudgeDetailResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: judgesAnalyticsKeys.detail(metricName, reportType),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("reportType", reportType);
      return apiClient.get<JudgeDetailResponse>(
        `/judges-analytics/${encodeURIComponent(metricName)}?${params.toString()}`
      );
    },
    enabled: Boolean(metricName) && Boolean(reportType),
    staleTime: JUDGES_ANALYTICS_QUERY_STALE_TIME_MS,
    ...options,
  });
}
