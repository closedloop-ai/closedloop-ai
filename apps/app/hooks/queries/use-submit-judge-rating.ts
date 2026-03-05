"use client";

import type {
  SubmitJudgeRatingRequest,
  SubmitJudgeRatingResponse,
} from "@repo/api/src/types/judges-analytics";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { judgeScoreKeys } from "./use-judge-scores";
import { myJudgeRatingsKeys } from "./use-my-judge-ratings";

// Mutation hook
export function useSubmitJudgeRating(artifactId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (body: SubmitJudgeRatingRequest) =>
      apiClient.post<SubmitJudgeRatingResponse>(
        `/artifacts/${artifactId}/judge-ratings`,
        body
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: judgeScoreKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: myJudgeRatingsKeys.detail(artifactId),
      });
    },
  });
}
