"use client";

import type { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { JudgeScoresResponse } from "@repo/api/src/types/judges-analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import {
  JUDGES_ANALYTICS_QUERY_STALE_TIME_MS,
  JUDGES_ANALYTICS_SCORE_PAGE_SIZE,
} from "@/lib/config/judges-analytics";

// Query keys
export const judgeScoreKeys = {
  all: ["judge-scores"] as const,
  list: (metricName: string, reportType: EvaluationReportType) =>
    [...judgeScoreKeys.all, metricName, reportType] as const,
  page: (metricName: string, reportType: EvaluationReportType, page: number) =>
    [...judgeScoreKeys.list(metricName, reportType), page] as const,
};

// Query hook
export function useJudgeScores(
  metricName: string,
  reportType: EvaluationReportType,
  page = 1,
  options?: Omit<UseQueryOptions<JudgeScoresResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: judgeScoreKeys.page(metricName, reportType, page),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("reportType", reportType);
      params.set("page", String(page));
      params.set("pageSize", String(JUDGES_ANALYTICS_SCORE_PAGE_SIZE));
      return apiClient.get<JudgeScoresResponse>(
        `/judges-analytics/${encodeURIComponent(metricName)}/scores?${params.toString()}`
      );
    },
    enabled: Boolean(metricName) && Boolean(reportType),
    staleTime: JUDGES_ANALYTICS_QUERY_STALE_TIME_MS,
    ...options,
  });
}
