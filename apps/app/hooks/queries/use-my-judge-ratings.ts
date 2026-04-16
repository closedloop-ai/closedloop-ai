"use client";

import type { UserJudgeRatingsResponse } from "@repo/api/src/types/judges-analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export const myJudgeRatingsKeys = {
  all: ["my-judge-ratings"] as const,
  detail: (documentId: string) =>
    [...myJudgeRatingsKeys.all, documentId] as const,
};

// Query hook
export function useMyJudgeRatings(
  documentId: string,
  options?: Omit<
    UseQueryOptions<UserJudgeRatingsResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: myJudgeRatingsKeys.detail(documentId),
    queryFn: () =>
      apiClient.get<UserJudgeRatingsResponse>(
        `/documents/${documentId}/judge-ratings`
      ),
    enabled: !!documentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
