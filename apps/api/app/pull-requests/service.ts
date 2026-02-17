import { analytics } from "@repo/analytics/server";
import type { PullRequestRatingSummary } from "@repo/api/src/types/pull-request-rating";
import { withDb } from "@repo/database";
import { PullRequestNotFoundError } from "./errors";

/**
 * Service for managing pull request ratings.
 * Follows the same pattern as artifactsService rating methods (lines 1439-1554).
 */
export const pullRequestRatingsService = {
  /**
   * Get rating summary for a pull request (org-scoped).
   * Returns the user's rating (if exists) plus aggregate statistics.
   * Authorization: PR lookup filters by organizationId (denormalized for defense-in-depth).
   */
  async getRating(
    pullRequestId: string,
    userId: string,
    organizationId: string
  ): Promise<PullRequestRatingSummary> {
    const { userRating, aggregate } = await withDb(async (db) => {
      // Verify PR belongs to user's organization (organizationId denormalized for defense-in-depth)
      const pullRequest = await db.gitHubPullRequest.findFirst({
        where: {
          id: pullRequestId,
          organizationId,
        },
      });

      if (!pullRequest) {
        throw new PullRequestNotFoundError(pullRequestId);
      }

      // Fetch user's rating and aggregate in parallel within same connection for atomic read
      const [userRating, aggregate] = await Promise.all([
        db.pullRequestRating.findUnique({
          where: {
            pullRequestId_userId_organizationId: {
              pullRequestId,
              userId,
              organizationId,
            },
          },
        }),
        db.pullRequestRating.aggregate({
          where: { pullRequestId, organizationId },
          _avg: { score: true },
          _count: true,
        }),
      ]);

      return { userRating, aggregate };
    });

    return {
      average: aggregate._avg.score ?? 0,
      count: aggregate._count,
      userRating: userRating
        ? {
            id: userRating.id,
            userId: userRating.userId,
            score: userRating.score,
            comment: userRating.comment,
            createdAt: userRating.createdAt,
            updatedAt: userRating.updatedAt,
          }
        : null,
    };
  },

  /**
   * Upsert a rating for a pull request (org-scoped).
   * Creates a new rating or updates an existing one, then returns updated aggregate statistics.
   * Validates PR ownership via organizationId (denormalized for defense-in-depth).
   */
  upsertRating(
    pullRequestId: string,
    userId: string,
    organizationId: string,
    score: number,
    comment: string
  ): Promise<PullRequestRatingSummary> {
    // Use transaction for atomicity: PR lookup + rating upsert + aggregate recalculation
    // must happen atomically to ensure data consistency.
    return withDb.tx(async (tx) => {
      // Verify PR belongs to user's organization (organizationId denormalized for defense-in-depth)
      const pullRequest = await tx.gitHubPullRequest.findFirst({
        where: {
          id: pullRequestId,
          organizationId,
        },
      });

      if (!pullRequest) {
        throw new PullRequestNotFoundError(pullRequestId);
      }

      // Check if rating exists to determine if this is a create or update
      const existingRating = await tx.pullRequestRating.findUnique({
        where: {
          pullRequestId_userId_organizationId: {
            pullRequestId,
            userId,
            organizationId,
          },
        },
      });

      const isUpdate = !!existingRating;

      // Upsert rating
      const rating = await tx.pullRequestRating.upsert({
        where: {
          pullRequestId_userId_organizationId: {
            pullRequestId,
            userId,
            organizationId,
          },
        },
        update: {
          score,
          comment,
        },
        create: {
          pullRequestId,
          userId,
          organizationId,
          score,
          comment,
        },
      });

      // Recalculate aggregate (same logic as getRating())
      const aggregate = await tx.pullRequestRating.aggregate({
        where: { pullRequestId, organizationId },
        _avg: { score: true },
        _count: true,
      });

      // AC-017 & AC-018: Track PR Rating Submitted (new) or PR Rating Updated
      analytics.capture({
        event: isUpdate ? "PR Rating Updated" : "PR Rating Submitted",
        distinctId: userId,
        properties: {
          pullRequestId,
          organizationId,
          score,
          hasComment: !!comment,
          previousScore: existingRating?.score,
          averageRating: aggregate._avg.score ?? 0,
          totalRatings: aggregate._count,
        },
      });

      return {
        average: aggregate._avg.score ?? 0,
        count: aggregate._count,
        userRating: {
          id: rating.id,
          userId: rating.userId,
          score: rating.score,
          comment: rating.comment,
          createdAt: rating.createdAt,
          updatedAt: rating.updatedAt,
        },
      };
    });
  },
};
