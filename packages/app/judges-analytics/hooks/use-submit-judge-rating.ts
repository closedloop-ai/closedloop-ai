"use client";

import type {
  SubmitJudgeRatingRequest,
  SubmitJudgeRatingResponse,
} from "@repo/api/src/types/judges-analytics";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { judgeScoreKeys } from "./use-judge-scores";
import { myJudgeRatingsKeys } from "./use-my-judge-ratings";

// Mutation hook
export function useSubmitJudgeRating(documentId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (body: SubmitJudgeRatingRequest) =>
      apiClient.post<SubmitJudgeRatingResponse>(
        `/documents/${documentId}/judge-ratings`,
        body
      ),
    onSuccess: (data) => {
      const cacheKey = data.metricName ?? data.promptName;
      if (cacheKey != null && data.reportType != null) {
        queryClient.invalidateQueries({
          queryKey: judgeScoreKeys.list(cacheKey, data.reportType),
        });
      } else {
        queryClient.invalidateQueries({ queryKey: judgeScoreKeys.all });
      }
      queryClient.invalidateQueries({
        queryKey: myJudgeRatingsKeys.detail(documentId),
      });
    },
  });
}
