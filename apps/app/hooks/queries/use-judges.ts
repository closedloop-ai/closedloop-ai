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
  prdDetail: (id: string) => [...judgesKeys.all, "prd-detail", id] as const,
  codeDetail: (id: string) => [...judgesKeys.all, "code-detail", id] as const,
};

function makeJudgesFeedbackHook(
  getEndpoint: (id: string) => string,
  keyFn: (id: string) => readonly unknown[]
) {
  return (artifactId: string): UseQueryResult<JudgeFeedbackItem[] | null> => {
    const apiClient = useApiClient();
    return useQuery({
      queryKey: keyFn(artifactId),
      queryFn: async () => {
        const response = await apiClient.get<JudgesFeedbackResponse>(
          getEndpoint(artifactId)
        );
        return response.status === "success" ? response.data : null;
      },
      enabled: !!artifactId,
      staleTime: 10 * 60 * 1000,
    });
  };
}

export const usePlanJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/artifacts/${id}/plan-judges`,
  judgesKeys.detail
);

export const usePrdJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/artifacts/${id}/prd-judges`,
  judgesKeys.prdDetail
);

export const useCodeJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/artifacts/${id}/code-judges`,
  judgesKeys.codeDetail
);
