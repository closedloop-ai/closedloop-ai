import type { CategoryBucket } from "@repo/api/src/types/insights";
import { GitHubPRState, ReviewDecision, withDb } from "@repo/database";
import {
  artifactScope,
  type InsightsScopeContext,
} from "@/app/insights/service";

export type ReviewQueueSnapshot = {
  buckets: CategoryBucket[];
  backlog: number;
};

const REVIEW_QUEUE_LABELS: Record<ReviewDecision | "PENDING", string> = {
  PENDING: "Awaiting review",
  [ReviewDecision.APPROVED]: "Approved, not merged",
  [ReviewDecision.CHANGES_REQUESTED]: "Changes requested",
  [ReviewDecision.COMMENTED]: "Commented",
  [ReviewDecision.DISMISSED]: "Dismissed",
};

// ONE `groupBy` snapshot feeds both the review-queue chart and the "Review
// backlog" KPI (ISS-4629), so they can't skew across reads and break the
// `backlog <= PENDING` reconciliation: the chart collapses the grid across
// `prState`, the backlog is the OPEN + null-decision cell (a provable subset of
// PENDING). `mergedAt: null` drops the stale OPEN-but-merged shape that
// `mapProviderPullRequestState` treats as MERGED when state projection trails
// the merge timestamp; the denormalized `organizationId` lets the planner lead
// with the `(organizationId, prState)` index prefix the join-reached
// `branchArtifact` scope alone cannot (see the schema note on that index).
export async function fetchReviewQueue(
  ctx: InsightsScopeContext
): Promise<ReviewQueueSnapshot> {
  const rows = await withDb((db) =>
    db.pullRequestDetail.groupBy({
      by: ["reviewDecision", "prState"],
      where: {
        organizationId: ctx.organizationId,
        branchArtifact: artifactScope(ctx),
        prState: { not: GitHubPRState.MERGED },
        mergedAt: null,
      },
      _count: { _all: true },
    })
  );
  const byDecision = new Map<ReviewDecision | "PENDING", number>();
  let backlog = 0;
  for (const row of rows) {
    const key = row.reviewDecision ?? "PENDING";
    byDecision.set(key, (byDecision.get(key) ?? 0) + row._count._all);
    if (row.reviewDecision === null && row.prState === GitHubPRState.OPEN) {
      backlog += row._count._all;
    }
  }
  return {
    backlog,
    buckets: [...byDecision].map(([key, value]) => ({
      key,
      label: REVIEW_QUEUE_LABELS[key],
      value,
    })),
  };
}
