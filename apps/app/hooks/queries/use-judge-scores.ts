"use client";

import type { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { JudgeScoresResponse } from "@repo/api/src/types/judges-analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const judgeScoreKeys = {
  all: ["judge-scores"] as const,
  list: (promptName: string, reportType: EvaluationReportType) =>
    [...judgeScoreKeys.all, promptName, reportType] as const,
  page: (promptName: string, reportType: EvaluationReportType, page: number) =>
    [...judgeScoreKeys.list(promptName, reportType), page] as const,
};

// Query hook
export function useJudgeScores(
  promptName: string,
  reportType: EvaluationReportType,
  page = 1,
  options?: Omit<UseQueryOptions<JudgeScoresResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: judgeScoreKeys.page(promptName, reportType, page),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("reportType", reportType);
      params.set("page", String(page));
      params.set("pageSize", "20");
      return apiClient.get<JudgeScoresResponse>(
        `/judges-analytics/${encodeURIComponent(promptName)}/scores?${params.toString()}`
      );
    },
    enabled: Boolean(promptName) && Boolean(reportType),
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
