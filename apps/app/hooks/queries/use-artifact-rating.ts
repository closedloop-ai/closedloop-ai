"use client";

import type {
  ArtifactRatingSummary,
  SubmitRatingRequest,
} from "@repo/api/src/types/rating";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const ratingKeys = {
  all: ["ratings"] as const,
  details: () => [...ratingKeys.all, "detail"] as const,
  detail: (artifactId: string) =>
    [...ratingKeys.details(), artifactId] as const,
};

// Query hook
export function useArtifactRating(
  artifactId: string,
  options?: Omit<UseQueryOptions<ArtifactRatingSummary>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: ratingKeys.detail(artifactId),
    queryFn: () =>
      apiClient.get<ArtifactRatingSummary>(`/artifacts/${artifactId}/rating`),
    enabled: !!artifactId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}

// Mutation hook
export function useSubmitRating() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      artifactId,
      score,
      comment,
    }: SubmitRatingRequest & { artifactId: string }) =>
      apiClient.put<ArtifactRatingSummary>(`/artifacts/${artifactId}/rating`, {
        score,
        comment,
      }),
    onSuccess: (_, { artifactId }) => {
      queryClient.invalidateQueries({
        queryKey: ratingKeys.detail(artifactId),
      });
    },
  });
}
