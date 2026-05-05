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
  featureDetail: (id: string) =>
    [...judgesKeys.all, "feature-detail", id] as const,
  codeDetail: (id: string) => [...judgesKeys.all, "code-detail", id] as const,
};

function makeJudgesFeedbackHook(
  getEndpoint: (id: string) => string,
  keyFn: (id: string) => readonly unknown[]
) {
  return (documentId: string): UseQueryResult<JudgeFeedbackItem[] | null> => {
    const apiClient = useApiClient();
    return useQuery({
      queryKey: keyFn(documentId),
      queryFn: async () => {
        const response = await apiClient.get<JudgesFeedbackResponse>(
          getEndpoint(documentId)
        );
        return response.status === "success" ? response.data : null;
      },
      enabled: !!documentId,
      staleTime: 10 * 60 * 1000,
    });
  };
}

export const usePlanJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/documents/${id}/plan-judges`,
  judgesKeys.detail
);

export const usePrdJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/documents/${id}/prd-judges`,
  judgesKeys.prdDetail
);

export const useFeatureJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/documents/${id}/feature-judges`,
  judgesKeys.featureDetail
);

export const useCodeJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/documents/${id}/code-judges`,
  judgesKeys.codeDetail
);
