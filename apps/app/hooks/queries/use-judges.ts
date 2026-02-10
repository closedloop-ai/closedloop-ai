"use client";

import type {
  JudgesFeedbackResponse,
  JudgesReport,
} from "@repo/api/src/types/evaluation";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const judgesKeys = {
  all: ["judges"] as const,
  detail: (id: string) => [...judgesKeys.all, "detail", id] as const,
};

// Query hook
export function useJudgesFeedback(
  artifactId: string
): UseQueryResult<JudgesReport | null> {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: judgesKeys.detail(artifactId),
    queryFn: async () => {
      const response = await apiClient.get<JudgesFeedbackResponse>(
        `/artifacts/${artifactId}/judges`
      );
      return response.status === "success" ? response.data : null;
    },
    enabled: !!artifactId,
    staleTime: 10 * 60 * 1000, // 10 minutes
  });
}
