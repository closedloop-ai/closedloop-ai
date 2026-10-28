import { GitHubCommentThreadKind, ThreadSource } from "@repo/database";
import type { GitHubProjectionDb } from "./github-projection-contract";
import { scopedThreadProjectionWhere } from "./github-projection-identity";

/**
 * The read-only half of the GitHub review-thread projection: what the
 * resolution webhook asks before it is allowed to call the provider.
 *
 * Split out of the projection writer (ISS-9116). Nothing here writes.
 */

export type GitHubReviewThreadResolutionProjection =
  | {
      status: typeof GitHubReviewThreadResolutionProjectionStatus.Eligible;
      threadId: string;
      threadExternalId: string;
    }
  | {
      status: Exclude<
        GitHubReviewThreadResolutionProjectionStatus,
        typeof GitHubReviewThreadResolutionProjectionStatus.Eligible
      >;
    };

export const GitHubReviewThreadResolutionProjectionStatus = {
  Eligible: "eligible",
  UnknownReviewThread: "unknown_review_thread",
  AmbiguousReviewThread: "ambiguous_review_thread",
  WrongScope: "wrong_scope",
} as const;
export type GitHubReviewThreadResolutionProjectionStatus =
  (typeof GitHubReviewThreadResolutionProjectionStatus)[keyof typeof GitHubReviewThreadResolutionProjectionStatus];

/**
 * Resolve one active, scoped review-thread projection for webhook-driven
 * resolution sync. The lookup is intentionally organization/branch/current-PR
 * scoped before any provider call is allowed.
 */
export async function findGitHubReviewThreadResolutionProjection(
  tx: GitHubProjectionDb,
  input: {
    organizationId: string;
    branchArtifactId: string;
    pullRequestDetailId: string;
    reviewThreadId: string;
    reviewCommentIds?: readonly string[];
  }
): Promise<GitHubReviewThreadResolutionProjection> {
  const reviewCommentIds = uniqueRemoteCommentIds(input.reviewCommentIds ?? []);
  const rows = await tx.gitHubCommentThreadProjection.findMany({
    where: {
      ...scopedThreadProjectionWhere(input),
      threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      OR: reviewThreadResolutionIdentity(
        input.reviewThreadId,
        reviewCommentIds
      ),
    },
    select: {
      thread: { select: { id: true, externalId: true } },
    },
    take: 2,
  });

  if (rows.length > 1) {
    return {
      status:
        GitHubReviewThreadResolutionProjectionStatus.AmbiguousReviewThread,
    };
  }

  const row = rows[0] ?? null;
  if (row?.thread.externalId) {
    return {
      status: GitHubReviewThreadResolutionProjectionStatus.Eligible,
      threadId: row.thread.id,
      threadExternalId: row.thread.externalId,
    };
  }

  const outOfScopeRow = await tx.gitHubCommentThreadProjection.findFirst({
    where: {
      threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      OR: reviewThreadResolutionIdentity(
        input.reviewThreadId,
        reviewCommentIds
      ),
      deletedAt: null,
      thread: {
        organizationId: input.organizationId,
        source: ThreadSource.GITHUB,
      },
    },
    select: { threadId: true },
  });

  return {
    status: outOfScopeRow
      ? GitHubReviewThreadResolutionProjectionStatus.WrongScope
      : GitHubReviewThreadResolutionProjectionStatus.UnknownReviewThread,
  };
}

function uniqueRemoteCommentIds(commentIds: readonly string[]): string[] {
  return [...new Set(commentIds.map((id) => id.trim()).filter(Boolean))];
}

function reviewThreadResolutionIdentity(
  reviewThreadId: string,
  reviewCommentIds: readonly string[]
) {
  return [
    { reviewThreadId },
    ...reviewCommentIds.map((rootCommentId) => ({ rootCommentId })),
    ...(reviewCommentIds.length > 0
      ? [
          {
            commentProjections: {
              some: {
                githubCommentId: { in: [...reviewCommentIds] },
                githubDeletedAt: null,
                comment: { deletedAt: null },
              },
            },
          },
        ]
      : []),
  ];
}
