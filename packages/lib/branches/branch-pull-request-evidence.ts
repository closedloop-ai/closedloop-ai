/**
 * How the branches-list metric fold reads pull-request evidence against ONE
 * window: which rows count as decided in it, and whether its answer is whole.
 *
 * Split from `branch-list-metrics.ts` (ISS-11589), which was back at the
 * 1,000-line ceiling. These four are the file's only pull-request-shaped
 * predicates and the only ones `calculateMergeRate` and
 * `calculateMedianPrSize` share, so they move as a unit.
 */
import type { BranchMetricWindow } from "@repo/api/src/types/branch-metrics";
import type {
  BranchListMetricInput,
  BranchMetricPullRequestEvidence,
} from "./branch-list-metrics";
import {
  isTimestampInBranchMetricWindow,
  locEvidenceAffectsWindow,
} from "./branch-metric-windows";

export function pullRequestMergedInWindow(
  pullRequest: BranchMetricPullRequestEvidence,
  window: BranchMetricWindow
): boolean {
  return isTimestampInBranchMetricWindow(pullRequest.mergedAt, window);
}

export function pullRequestClosedUnmergedInWindow(
  pullRequest: BranchMetricPullRequestEvidence,
  window: BranchMetricWindow
): boolean {
  return (
    pullRequest.mergedAt === null &&
    isTimestampInBranchMetricWindow(pullRequest.closedAt, window)
  );
}

/** Distinct decided identities the cohort PRESENTED, before reconciliation. */
export function decidedPullRequestIdentityCount(
  pullRequests: readonly BranchMetricPullRequestEvidence[],
  window: BranchMetricWindow
): number {
  const identities = new Set<string>();
  for (const pullRequest of pullRequests) {
    if (
      pullRequest.identity &&
      (pullRequestMergedInWindow(pullRequest, window) ||
        pullRequestClosedUnmergedInWindow(pullRequest, window))
    ) {
      identities.add(pullRequest.identity);
    }
  }
  return identities.size;
}

/**
 * Whether a window's pull-request answer is whole.
 *
 * Mirrors `locCoverageIsComplete`, which stayed module-private in
 * `branch-list-metrics.ts`: a producer that supplies gaps has said
 * everything it knows, so a window no gap reaches is complete even while the
 * cohort-wide flag is false. Supplying an EMPTY array is that same statement,
 * and is the case both producers actually rely on — a cohort whose only
 * shortfalls hide no decision emits no gap at all, and reading that as "no gaps,
 * fall back to the flag" would star every window exactly as before. Only
 * omitting the field keeps the old all-or-nothing flag, which is what every
 * pre-ISS-9959 caller and fixture gets.
 */
export function pullRequestCoverageIsComplete(
  input: BranchListMetricInput,
  window: BranchMetricWindow
): boolean {
  const gaps = input.pullRequestCoverageGaps;
  if (gaps === undefined) {
    return input.pullRequestCoverageComplete === true;
  }
  return !gaps.some((gap) => locEvidenceAffectsWindow(gap.occurredAt, window));
}
