import type { CategoryBucket } from "./insights";

/**
 * ISS-12256 — the Delivery "Branch coverage" chart's two buckets over a Branch
 * population: branches with at least one pull request, and branches with none.
 *
 * One builder for the cloud insights service and the Desktop local Dashboard,
 * so the two sources cannot key or label the same chart differently. The
 * labels are the cloud chart's existing ones (`insights-branch-population.ts`).
 */
export function branchCoverageBuckets(
  withPullRequest: number,
  withoutPullRequest: number
): CategoryBucket[] {
  return [
    {
      key: BranchCoverageBucketKey.HasPullRequest,
      label: "Has a pull request",
      value: withPullRequest,
    },
    {
      key: BranchCoverageBucketKey.NoPullRequest,
      label: "No pull request",
      value: withoutPullRequest,
    },
  ];
}

export const BranchCoverageBucketKey = {
  HasPullRequest: "has-pr",
  NoPullRequest: "no-pr",
} as const;
export type BranchCoverageBucketKey =
  (typeof BranchCoverageBucketKey)[keyof typeof BranchCoverageBucketKey];
