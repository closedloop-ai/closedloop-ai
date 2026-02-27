"use client";

import type {
  JudgeFeedbackItem,
  JudgesFeedbackResponse,
} from "@repo/api/src/types/evaluation";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const judgesKeys = {
  all: ["judges"] as const,
  detail: (id: string) => [...judgesKeys.all, "detail", id] as const,
  codeDetail: (id: string) => [...judgesKeys.all, "code-detail", id] as const,
};

function makeJudgesFeedbackHook(
  endpoint: string,
  keyFn: (id: string) => readonly unknown[]
) {
  return (artifactId: string): UseQueryResult<JudgeFeedbackItem[] | null> => {
    const apiClient = useApiClient();
    return useQuery({
      queryKey: keyFn(artifactId),
      queryFn: async () => {
        const response = await apiClient.get<JudgesFeedbackResponse>(
          endpoint.replace(":id", artifactId)
        );
        return response.status === "success" ? response.data : null;
      },
      enabled: !!artifactId,
      staleTime: 10 * 60 * 1000, // 10 minutes
    });
  };
}

export const useJudgesFeedback = makeJudgesFeedbackHook(
  "/artifacts/:id/judges",
  judgesKeys.detail
);

export const useCodeJudgesFeedback = makeJudgesFeedbackHook(
  "/artifacts/:id/code-judges",
  judgesKeys.codeDetail
);
