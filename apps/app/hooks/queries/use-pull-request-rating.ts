"use client";

import type {
  PullRequestRatingResponse,
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
    staleTime: 30 * 1000, // 30 seconds - ratings change during collaborative review
    ...options,
  });
}

/**
 * Mutation hook for submitting or updating a pull request rating.
 * Supports both rating-only submissions and rating + comment.
 * Uses optimistic updates to avoid UI flicker when isEditing transitions to false
 * before cache invalidation completes.
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
    onMutate: async ({ pullRequestId, score, comment }) => {
      const queryKey = pullRequestRatingKeys.detail(pullRequestId);
      await queryClient.cancelQueries({ queryKey });

      const previous =
        queryClient.getQueryData<PullRequestRatingSummary>(queryKey);

      const now = new Date();
      const optimisticUserRating: PullRequestRatingResponse = {
        id: previous?.userRating?.id ?? "temp",
        userId: previous?.userRating?.userId ?? "temp",
        score,
        comment,
        createdAt: previous?.userRating?.createdAt ?? now,
        updatedAt: now,
      };

      queryClient.setQueryData<PullRequestRatingSummary>(queryKey, (old) => ({
        ...(old ?? { average: 0, count: 0, userRating: null }),
        userRating: optimisticUserRating,
      }));

      return { previous };
    },
    onError: (_err, { pullRequestId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          pullRequestRatingKeys.detail(pullRequestId),
          context.previous
        );
      }
    },
    onSuccess: (_, { pullRequestId }) => {
      // Invalidate all rating queries for this PR so aggregate stats (average, count)
      // stay fresh for all viewers in collaborative code review sessions.
      queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "pullRequestRatings" &&
          query.queryKey.includes(pullRequestId),
      });
    },
  });
}
