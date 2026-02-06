"use client";

import type {
  ArtifactRatingSummary,
  SubmitRatingRequest,
} from "@repo/api/src/types/rating";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type UseMutationOptions,
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

// Context type for optimistic updates
type SubmitRatingContext = {
  previousRating: ArtifactRatingSummary | undefined;
};

// Mutation hook
export function useSubmitRating(
  options?: UseMutationOptions<
    ArtifactRatingSummary,
    Error,
    SubmitRatingRequest & { artifactId: string },
    SubmitRatingContext
  >
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationKey: ["submit-rating"], // Will be extended with artifactId in mutationFn
    mutationFn: ({ artifactId, score, comment }) =>
      apiClient.put<ArtifactRatingSummary>(`/artifacts/${artifactId}/rating`, {
        score,
        comment,
      }),
    onMutate: async (variables) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({
        queryKey: ratingKeys.detail(variables.artifactId),
      });

      // Snapshot the previous value
      const previousRating = queryClient.getQueryData<ArtifactRatingSummary>(
        ratingKeys.detail(variables.artifactId)
      );

      // Optimistically update only the user's rating (not aggregate)
      queryClient.setQueryData<ArtifactRatingSummary>(
        ratingKeys.detail(variables.artifactId),
        (old) =>
          old
            ? {
                ...old,
                userRating: old.userRating
                  ? {
                      ...old.userRating,
                      score: variables.score,
                      comment: variables.comment,
                      updatedAt: new Date(),
                    }
                  : null,
              }
            : old
      );

      return { previousRating };
    },
    onError: (_error, variables, context) => {
      // Rollback on error
      if (context?.previousRating) {
        queryClient.setQueryData(
          ratingKeys.detail(variables.artifactId),
          context.previousRating
        );
      }
      toast.error("Failed to submit rating. Please try again.");
    },
    onSuccess: async (_data, variables, context) => {
      // Invalidate to fetch fresh aggregate data from server
      await queryClient.invalidateQueries({
        queryKey: ratingKeys.detail(variables.artifactId),
      });

      // Show contextual toast
      const hadPreviousRating = context?.previousRating?.userRating != null;
      toast.success(hadPreviousRating ? "Rating updated" : "Rating submitted");
    },
    ...options,
  });
}
