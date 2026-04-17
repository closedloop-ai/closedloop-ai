import { ReviewDecision } from "@repo/api/src/types/document";
import type { TransactionClient } from "@repo/database";

/**
 * Priority order for review decisions. Higher numbers take precedence.
 * DISMISSED reviews are excluded from aggregate computation (filtered before this is used).
 */
const REVIEW_DECISION_PRIORITY = {
  [ReviewDecision.ChangesRequested]: 3,
  [ReviewDecision.Approved]: 2,
  [ReviewDecision.Commented]: 1,
  null: 0,
} as const;

/**
 * Compute the aggregate review decision from a list of per-reviewer states.
 * Filters out DISMISSED reviews (neutralized by admin action), then takes
 * the highest-priority value across remaining active reviewers.
 * Returns null if no active reviews exist.
 */
export function computeAggregateReviewDecision(
  reviewStates: ReviewDecision[]
): ReviewDecision | null {
  const activeStates = reviewStates.filter(
    (s) => s !== ReviewDecision.Dismissed
  );

  if (activeStates.length === 0) {
    return null;
  }

  let highest: ReviewDecision = activeStates[0];
  for (const state of activeStates) {
    if (
      REVIEW_DECISION_PRIORITY[state as keyof typeof REVIEW_DECISION_PRIORITY] >
      REVIEW_DECISION_PRIORITY[highest as keyof typeof REVIEW_DECISION_PRIORITY]
    ) {
      highest = state;
    }
  }
  return highest;
}

/**
 * Recompute aggregate reviewDecision from all per-reviewer reviews and update the PR.
 */
export async function recomputeAndUpdateAggregate(
  tx: TransactionClient,
  pullRequestId: string
): Promise<ReviewDecision | null> {
  const allReviews = await tx.gitHubPRReview.findMany({
    where: { pullRequestId },
    select: { state: true },
  });

  const aggregateDecision = computeAggregateReviewDecision(
    allReviews.map((r: { state: string }) => r.state as ReviewDecision)
  );

  await tx.gitHubPullRequest.update({
    where: { id: pullRequestId },
    data: { reviewDecision: aggregateDecision },
  });

  return aggregateDecision;
}
