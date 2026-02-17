"use client";

import type {
  PullRequestRatingSummary,
  SubmitPullRequestRatingRequest,
} from "@repo/api/src/types/pull-request-rating";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

/**
 * Query key factory for pull request ratings.
 * Follows the artifact rating pattern for consistent cache management.
 */
export const pullRequestRatingKeys = {
  all: ["pullRequestRatings"] as const,
  details: () => [...pullRequestRatingKeys.all, "detail"] as const,
  detail: (pullRequestId: string) =>
    [...pullRequestRatingKeys.details(), pullRequestId] as const,
};

/**
 * Query hook for fetching pull request rating summary.
 * Returns the authenticated user's rating plus aggregate statistics (average, count).
 *
 * @param pullRequestId - GitHub pull request ID (nullable to support conditional rendering)
 * @param options - TanStack Query options (staleTime, refetchInterval, etc.)
 */
export function usePullRequestRating(
  pullRequestId: string | null | undefined,
  options?: Omit<
    UseQueryOptions<PullRequestRatingSummary>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: pullRequestRatingKeys.detail(pullRequestId ?? ""),
    queryFn: () =>
      apiClient.get<PullRequestRatingSummary>(
        `/pull-requests/${pullRequestId}/rating`
      ),
    enabled: !!pullRequestId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}

/**
 * Mutation hook for submitting or updating a pull request rating.
 * Supports both rating-only submissions and rating + comment.
 * Automatically invalidates the rating cache on success.
 */
export function useSubmitPullRequestRating() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      pullRequestId,
      score,
      comment,
    }: SubmitPullRequestRatingRequest & { pullRequestId: string }) =>
      apiClient.put<PullRequestRatingSummary>(
        `/pull-requests/${pullRequestId}/rating`,
        {
          score,
          comment,
        }
      ),
    onSuccess: (_, { pullRequestId }) => {
      queryClient.invalidateQueries({
        queryKey: pullRequestRatingKeys.detail(pullRequestId),
      });
    },
  });
}
