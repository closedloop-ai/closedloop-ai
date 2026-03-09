"use client";

import type { EvaluationReportType } from "@repo/api/src/types/evaluation";
import {
  type ArtifactCountsGroupBy as ArtifactCountsGroupByType,
  type ArtifactCountsResponse,
  type JudgeDetailResponse,
  type JudgeStatsResponse,
  PR_TIMELINE_GRANULARITY_OPTIONS,
  type PrHealthResponse,
  type PrTimelineGranularity,
} from "@repo/api/src/types/judges-analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
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
  detail: (promptName: string, reportType: EvaluationReportType) =>
    [...judgesAnalyticsKeys.all, "detail", promptName, reportType] as const,
  prHealth: (
    promptName: string,
    reportType: string,
    startDate: string,
    endDate: string,
    granularity: PrTimelineGranularity
  ) =>
    [
      ...judgesAnalyticsKeys.all,
      "pr-health",
      promptName,
      reportType,
      startDate,
      endDate,
      granularity,
    ] as const,
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
    staleTime: JUDGES_ANALYTICS_QUERY_STALE_TIME_MS,
    ...options,
  });
}

export function usePrHealth(
  promptName: string,
  reportType: string,
  rangeDays: number,
  granularity: PrTimelineGranularity = PR_TIMELINE_GRANULARITY_OPTIONS.Week
) {
  const apiClient = useApiClient();
  const endDate = format(new Date(), "yyyy-MM-dd");
  const startDate = format(subDays(new Date(), rangeDays), "yyyy-MM-dd");

  return useQuery({
    queryKey: judgesAnalyticsKeys.prHealth(
      promptName,
      reportType,
      startDate,
      endDate,
      granularity
    ),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("reportType", reportType);
      params.set("startDate", startDate);
      params.set("endDate", endDate);
      params.set("granularity", granularity);
      return apiClient.get<PrHealthResponse>(
        `/judges-analytics/${encodeURIComponent(promptName)}/pr-health?${params.toString()}`
      );
    },
    enabled: Boolean(promptName) && Boolean(reportType),
    staleTime: JUDGES_ANALYTICS_QUERY_STALE_TIME_MS,
  });
}
