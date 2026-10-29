/**
 * The branches-list metric fold's window-INDEPENDENT reconciliations, each paid
 * once per request (ISS-10363).
 *
 * Extracted from `branch-list-metrics.ts`, which was at the 1,000-line ceiling:
 * these five share one property that nothing else in that file shares, which is
 * exactly why they can be memoized at all.
 */

import { resolveMergedPullRequestTwins } from "../pull-requests/merged-pr-twin-resolution";
import type {
  BranchMetricPullRequestEvidence,
  BranchMetricStatusSnapshot,
} from "./branch-list-metrics";
import {
  memoizePerEvidenceArray,
  type ReconciledEvidence,
  reconcileByIdentity,
} from "./branch-metric-evidence-reconciliation";
import {
  type BranchMetricLocContribution,
  reconcileBranchPublicationLoc,
} from "./branch-publication-loc";
import { pushedChangeIdentities } from "./branch-pushed-loc";

// ISS-10363 (tamsinb review on #7448): these five reconciliations are pure
// functions of ONE evidence array — the window filter always runs on their
// OUTPUT, never their input, deliberately, because filtering first would hide a
// disagreement about an out-of-window row from the only pass that detects it.
// So a per-window fold re-derived an identical result every time, and the series
// turned two folds into fourteen. Memoized on the array's own identity, one
// request reconciles once and every further bucket pays only its own filter.
// Nothing about WHAT is reconciled changes, so the conflict detection each call
// site depends on is byte-identical.
export const reconcilePublicationLoc = memoizePerEvidenceArray(
  (contributions: readonly BranchMetricLocContribution[]) =>
    reconcileBranchPublicationLoc(contributions)
);

export const memoizedPushedChangeIdentities = memoizePerEvidenceArray(
  (contributions: readonly BranchMetricLocContribution[]) =>
    pushedChangeIdentities(contributions)
);

export const reconcileStatusSnapshots = memoizePerEvidenceArray(
  (
    snapshots: readonly BranchMetricStatusSnapshot[]
  ): ReconciledEvidence<BranchMetricStatusSnapshot> =>
    reconcileByIdentity(snapshots, (snapshot) => snapshot.branchId)
);

/**
 * The one reconciliation here whose disagreements are not all unresolvable, so
 * it splits them by whether an authority exists (ISS-11589).
 *
 * `reconcileByIdentity` erases both rows on ANY difference, which is right for
 * a cost contribution or a status snapshot: no field there says which row is
 * more likely correct. For a pull request's DIFF STATS one does — a sized row
 * beats an unsized twin, and between two sized rows the App-owned one carries a
 * `githubId` only the webhook path writes — and that is the whole shortfall the
 * card was starring: the Insights dashboard resolved the pair while the card
 * dropped both, so one label published two populations.
 *
 * The tie-break ranks NOTHING ELSE, so it confers no authority over the
 * lifecycle fields. `pullRequestMergedInWindow` reads `mergedAt` and
 * `closedAt` off the winner to decide whether the pull request is in the
 * merged population at all, so letting a diff-stat winner carry a lifecycle its
 * twin contradicts would drop a merge this cohort HAD read and publish the
 * shortened rate as complete. Those rows stay on the drop-both rule, and
 * `conflicted` covers them alongside a row that carried no identity.
 *
 * Nor does the tie-break always SUCCEED. Desktop never writes a `githubId`, so
 * two sized repo-less rows disagreeing about one pull request leave arrival
 * order holding the answer, and that pair carried `conflicted` before this
 * reconciliation existed. `unsettledDisagreementCount` keeps it carrying it
 * (tamsinb review on #8237) — the winner still publishes, so the figure is a
 * real one, but the card cannot call it complete.
 */
export const reconcilePullRequests = memoizePerEvidenceArray(
  (
    pullRequests: readonly BranchMetricPullRequestEvidence[]
  ): ReconciledEvidence<BranchMetricPullRequestEvidence> => {
    const byIdentity = new Map<string, BranchMetricPullRequestEvidence[]>();
    let conflicted = false;
    for (const pullRequest of pullRequests) {
      if (!pullRequest.identity) {
        conflicted = true;
        continue;
      }
      const claimants = byIdentity.get(pullRequest.identity);
      if (claimants) {
        claimants.push(pullRequest);
        continue;
      }
      byIdentity.set(pullRequest.identity, [pullRequest]);
    }
    const values: BranchMetricPullRequestEvidence[] = [];
    for (const claimants of byIdentity.values()) {
      if (lifecycleAgrees(claimants)) {
        const resolution = resolveMergedPullRequestTwins(
          claimants,
          (pullRequest) => pullRequest.identity
        );
        if (resolution.unsettledDisagreementCount > 0) {
          conflicted = true;
        }
        values.push(...resolution.values);
        continue;
      }
      conflicted = true;
    }
    return { values, conflicted };
  }
);

/** Whether every row claiming one pull request tells the same lifecycle story. */
function lifecycleAgrees(
  claimants: readonly BranchMetricPullRequestEvidence[]
): boolean {
  const [first, ...rest] = claimants;
  if (!first) {
    return true;
  }
  return rest.every(
    (pullRequest) =>
      pullRequest.mergedAt === first.mergedAt &&
      pullRequest.closedAt === first.closedAt
  );
}
