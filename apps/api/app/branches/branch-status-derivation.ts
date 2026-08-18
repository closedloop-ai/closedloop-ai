import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchMergedState,
  deriveBranchMergedState,
} from "@repo/api/src/types/branch-merged-state";
import { GitHubPRState } from "@repo/api/src/types/github";
import { getOwnedCurrentPullRequestDetail } from "./branch-remote-evidence";

// Fields any branch row (full or narrowed analytics select) exposes for status
// derivation. Keeping the derivation in one generic helper guarantees the list
// view and the analytics KPIs classify the same branch identically (FEA-2741).
export type StatusDerivationDetail = {
  branchArtifactId: string;
  isCurrent: boolean;
  // Nullable for desktop-produced PRs in non-App repos (FEA-2732).
  repositoryId: string | null;
  prState: GitHubPRState | null;
  isDraft: boolean;
  mergedAt: Date | null;
};

export type StatusDerivationRow<Detail extends StatusDerivationDetail> = {
  id: string;
  status: string;
  branch: {
    repositoryId: string | null;
    currentPullRequestDetail: Detail | null;
  };
  pullRequestDetails: readonly Detail[];
};

/**
 * Resolves a branch row's owned current PR and its derived {@link BranchStatus}
 * from that PR's lifecycle. The classification is shared by the list view and the
 * analytics KPIs (via `toBranchAnalyticsMetrics`) so both surfaces bucket the same
 * branch identically (FEA-2741).
 */
export function deriveBranchRowStatus<Detail extends StatusDerivationDetail>(
  row: StatusDerivationRow<Detail>
): { pr: Detail | null; status: BranchStatus } {
  const pr = getOwnedCurrentPullRequestDetail(row);
  const mergedState = deriveBranchMergedState({
    connectedPrState: pr?.prState ?? null,
    connectedMergedAt: pr?.mergedAt ?? null,
    hasConnectedPrEvidence: Boolean(pr),
    localArtifactStatus: row.status,
  });
  return {
    pr,
    status: toBranchStatus(
      row.status,
      pr?.prState ?? null,
      pr?.isDraft ?? false,
      mergedState
    ),
  };
}

/**
 * Maps a branch's local artifact status + connected PR lifecycle to the canonical
 * {@link BranchStatus}.
 *
 * FEA-4333: MERGE EVIDENCE wins over a stale draft flag. A PR that GitHub reports
 * merged (mergedState resolved via merge evidence in `deriveBranchMergedState`) is
 * Merged even if a stale capture still carries `isDraft=true` (a merged draft, or
 * a draft flag not yet cleared). Checking `isDraft` first classified such a branch
 * as Draft, so it fell into `activeBranchCount` (status ≠ merged/closed) while its
 * connected PR was ALSO counted in `mergedCount` via `countPrLifecycle` — the same
 * active-vs-merged double-classification this ticket removes, one layer up in the
 * branch-status derivation. Merge is terminal, so it precedes draft here; this also
 * matches the desktop producer, whose already-merge-aware `prState` maps to Merged
 * before its Draft fallback (`shared-branches-api.ts`).
 */
export function toBranchStatus(
  artifactStatus: string,
  prState: GitHubPRState | null,
  isDraft: boolean,
  mergedState: BranchMergedState
): BranchStatus {
  if (mergedState === BranchMergedState.Merged) {
    return BranchStatus.Merged;
  }
  if (isDraft) {
    return BranchStatus.Draft;
  }
  if (
    artifactStatus === GitHubPRState.Closed ||
    prState === GitHubPRState.Closed
  ) {
    return BranchStatus.Closed;
  }
  return BranchStatus.Open;
}
