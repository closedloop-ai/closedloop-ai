import { analytics } from "@repo/analytics/server";
import type { PullRequestRatingSummary } from "@repo/api/src/types/pull-request-rating";
import { withDb } from "@repo/database";

/**
 * Error thrown when a pull request is not found or doesn't belong to the user's organization.
 * Used for consistent error handling across pull request rating operations.
 */
export class PullRequestNotFoundError extends Error {
  readonly status = 404;
  constructor(pullRequestId: string) {
    super(`Pull request not found: ${pullRequestId}`);
    this.name = "PullRequestNotFoundError";
  }
}

/**
 * Service for managing pull request ratings.
 * Follows the same pattern as artifactsService rating methods (lines 1439-1554).
 */
export const pullRequestRatingsService = {
  /**
   * Get rating summary for a pull request (org-scoped).
   * Returns the user's rating (if exists) plus aggregate statistics.
   * Authorization is implicit: if the PR doesn't belong to the user's org, aggregate returns empty.
   */
  async getRating(
    pullRequestId: string,
    userId: string,
    organizationId: string
  ): Promise<PullRequestRatingSummary> {
    // Fetch user's rating (if exists)
    const userRating = await withDb((db) =>
      db.pullRequestRating.findUnique({
        where: {
          pullRequestId_userId_organizationId: {
            pullRequestId,
            userId,
            organizationId,
          },
        },
      })
    );

    // Fetch aggregate statistics (MUST filter by both pullRequestId AND organizationId for multi-tenant isolation)
    const aggregate = await withDb((db) =>
      db.pullRequestRating.aggregate({
        where: { pullRequestId, organizationId },
        _avg: { score: true },
        _count: true,
      })
    );

    // AC-016: Track PR Rating Viewed event
    analytics.capture({
      event: "PR Rating Viewed",
      distinctId: userId,
      properties: {
        pullRequestId,
        organizationId,
        hasUserRating: !!userRating,
        averageRating: aggregate._avg.score ?? 0,
        totalRatings: aggregate._count,
      },
    });

    return {
      average: aggregate._avg.score ?? 0,
      count: aggregate._count,
      userRating: userRating
        ? {
            id: userRating.id,
            userId: userRating.userId,
            score: userRating.score,
            comment: userRating.comment ?? undefined,
            createdAt: userRating.createdAt,
            updatedAt: userRating.updatedAt,
          }
        : null,
    };
  },

  /**
   * Upsert a rating for a pull request (org-scoped).
   * Creates a new rating or updates an existing one, then returns updated aggregate statistics.
   * Validates PR ownership via artifact join (PRs are linked via artifacts to organizations).
   */
  upsertRating(
    pullRequestId: string,
    userId: string,
    organizationId: string,
    score: number,
    comment?: string
  ): Promise<PullRequestRatingSummary> {
    // Use transaction for atomicity: PR lookup + rating upsert + aggregate recalculation
    // must happen atomically to ensure data consistency.
    return withDb.tx(async (tx) => {
      // Verify PR belongs to user's organization via artifact relation
      // GitHubPullRequest lacks direct organizationId field, so we join through artifact
      const pullRequest = await tx.gitHubPullRequest.findFirst({
        where: {
          id: pullRequestId,
          artifact: {
            organizationId,
          },
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
          updatedAt: new Date(),
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
          comment: rating.comment ?? undefined,
          createdAt: rating.createdAt,
          updatedAt: rating.updatedAt,
        },
      };
    });
  },
};
