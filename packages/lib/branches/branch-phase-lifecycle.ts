import type { BranchAssociatedPullRequestCollection } from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import type { BranchPhasePullRequestCycle } from "./branch-phase-attribution";

/** Provider-neutral lifecycle input derived from the landed associated-PR contract. */
export type BranchPhaseLifecycleInput = {
  pullRequestCycles: BranchPhasePullRequestCycle[];
  ambiguousWriteAfter: string[];
};

/**
 * Preserve a folded prior close as a terminal cycle without guessing the later
 * reopen boundary. Writes after it remain unavailable until explicit evidence
 * can place them before or after that reopen.
 */
export function branchPhaseLifecycleFromAssociatedPullRequests(
  collection: BranchAssociatedPullRequestCollection | undefined
): BranchPhaseLifecycleInput {
  const pullRequestCycles: BranchPhasePullRequestCycle[] = [];
  const ambiguousWriteAfter: string[] = [];
  for (const pullRequest of collection?.items ?? []) {
    const hasFoldedReopen =
      pullRequest.state === GitHubPRState.Open && pullRequest.closedAt !== null;
    pullRequestCycles.push({
      pullRequestId: pullRequest.id,
      openedAt: pullRequest.openedAt,
      terminalAt: hasFoldedReopen
        ? pullRequest.closedAt
        : (pullRequest.mergedAt ?? pullRequest.closedAt),
    });
    if (hasFoldedReopen && pullRequest.closedAt) {
      ambiguousWriteAfter.push(pullRequest.closedAt);
    }
  }
  return { pullRequestCycles, ambiguousWriteAfter };
}
