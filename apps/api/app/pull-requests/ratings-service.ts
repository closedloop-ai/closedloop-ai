import { analytics } from "@repo/analytics/server";
import type { PullRequestRatingSummary } from "@repo/api/src/types/pull-request-rating";
import { Result, Status } from "@repo/api/src/types/result";
import { ArtifactType, withDb } from "@repo/database";

/**
 * Service for managing branch artifact ratings through the legacy PR rating route.
 *
 * Ratings are stored in the unified `artifact_ratings` table keyed by
 * `artifactId` (the BRANCH artifact id). Rating rows carry
 * `artifactVersion: null` for branch ratings.
 *
 * Both methods are org-scoped: the PR artifact is verified to belong to the
 * caller's organization before the rating row is read or upserted. When the
 * PR is missing or belongs to another org, methods return
 * `Result.err(Status.NotFound)` so the route can map to a 404 without
 * try/catch boilerplate.
 */
export const pullRequestRatingsService = {
  /**
   * Get rating summary for a pull request (org-scoped). Returns the user's
   * rating (if any) plus aggregate statistics.
   */
  async getRating(
    pullRequestId: string,
    userId: string,
    organizationId: string
  ): Promise<Result<PullRequestRatingSummary>> {
    const fetched = await withDb(async (db) => {
      // Verify branch artifact belongs to user's organization.
      const pullRequest = await db.artifact.findFirst({
        where: {
          id: pullRequestId,
          organizationId,
          type: ArtifactType.BRANCH,
        },
        select: { id: true },
      });

      if (!pullRequest) {
        return null;
      }

      // Fetch user's rating and aggregate in parallel within same connection
      // for atomic read.
      const [userRating, aggregate] = await Promise.all([
        db.artifactRating.findUnique({
          where: {
            artifactId_userId_organizationId: {
              artifactId: pullRequestId,
              userId,
              organizationId,
            },
          },
        }),
        db.artifactRating.aggregate({
          where: { artifactId: pullRequestId, organizationId },
          _avg: { score: true },
          _count: { _all: true },
        }),
      ]);

      return { userRating, aggregate };
    });

    if (!fetched) {
      return Result.err(Status.NotFound);
    }

    const { userRating, aggregate } = fetched;
    return Result.ok({
      average: aggregate._avg?.score ?? 0,
      count: aggregate._count._all,
      userRating: userRating
        ? {
            id: userRating.id,
            userId: userRating.userId,
            score: userRating.score,
            comment: userRating.comment ?? "",
            createdAt: userRating.createdAt,
            updatedAt: userRating.updatedAt,
          }
        : null,
    });
  },

  /**
   * Upsert a rating for a pull request (org-scoped). Creates a new rating or
   * updates an existing one, then returns updated aggregate statistics.
   */
  upsertRating(
    pullRequestId: string,
    userId: string,
    organizationId: string,
    score: number,
    comment: string
  ): Promise<Result<PullRequestRatingSummary>> {
    // Use transaction for atomicity: PR lookup + rating upsert + aggregate
    // recalculation must happen atomically to ensure data consistency.
    return withDb.tx(async (tx) => {
      // Verify branch artifact belongs to user's organization.
      const pullRequest = await tx.artifact.findFirst({
        where: {
          id: pullRequestId,
          organizationId,
          type: ArtifactType.BRANCH,
        },
        select: { id: true },
      });

      if (!pullRequest) {
        return Result.err(Status.NotFound);
      }

      // Check if rating exists to determine if this is a create or update.
      const existingRating = await tx.artifactRating.findUnique({
        where: {
          artifactId_userId_organizationId: {
            artifactId: pullRequestId,
            userId,
            organizationId,
          },
        },
      });

      const isUpdate = !!existingRating;

      const rating = await tx.artifactRating.upsert({
        where: {
          artifactId_userId_organizationId: {
            artifactId: pullRequestId,
            userId,
            organizationId,
          },
        },
        update: { score, comment },
        create: {
          artifactId: pullRequestId,
          userId,
          organizationId,
          score,
          comment,
        },
      });

      // Recalculate aggregate (same logic as getRating()).
      const aggregate = await tx.artifactRating.aggregate({
        where: { artifactId: pullRequestId, organizationId },
        _avg: { score: true },
        _count: { _all: true },
      });

      // AC-017 & AC-018 compatibility: keep the analytics event names while
      // the legacy route name remains, but the identifier now belongs to a branch artifact.
      analytics.capture({
        event: isUpdate ? "PR Rating Updated" : "PR Rating Submitted",
        distinctId: userId,
        properties: {
          pullRequestId,
          organizationId,
          score,
          hasComment: !!comment,
          previousScore: existingRating?.score,
          averageRating: aggregate._avg?.score ?? 0,
          totalRatings: aggregate._count._all,
        },
      });

      return Result.ok({
        average: aggregate._avg?.score ?? 0,
        count: aggregate._count._all,
        userRating: {
          id: rating.id,
          userId: rating.userId,
          score: rating.score,
          comment: rating.comment ?? "",
          createdAt: rating.createdAt,
          updatedAt: rating.updatedAt,
        },
      });
    });
  },
};
