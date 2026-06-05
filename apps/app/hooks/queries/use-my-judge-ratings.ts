"use client";

import type { UserJudgeRatingsResponse } from "@repo/api/src/types/judges-analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export const myJudgeRatingsKeys = {
  all: ["my-judge-ratings"] as const,
  detail: (artifactId: string) =>
    [...myJudgeRatingsKeys.all, artifactId] as const,
};

// Query hook
export function useMyJudgeRatings(
  artifactId: string,
  options?: Omit<
    UseQueryOptions<UserJudgeRatingsResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: myJudgeRatingsKeys.detail(artifactId),
    queryFn: () =>
      apiClient.get<UserJudgeRatingsResponse>(
        `/artifacts/${artifactId}/judge-ratings`
      ),
    enabled: !!artifactId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
