import {
  GitHubPRState,
  type GitHubPRState as GitHubPRStateValue,
} from "./github-status";

export const BranchMergedState = {
  Merged: "merged",
  NotMerged: "not_merged",
  Unknown: "unknown",
} as const;
export type BranchMergedState =
  (typeof BranchMergedState)[keyof typeof BranchMergedState];

export type BranchMergedStateInput = {
  connectedPrState?: GitHubPRStateValue | null;
  connectedMergedAt?: string | Date | null;
  hasConnectedPrEvidence?: boolean;
  localArtifactStatus?: string | null;
};

/**
 * Classifies an in-memory Branches row using connected PR evidence first.
 * DB-side SQL aggregate predicates cannot consume this helper directly and
 * should stay explicitly inventoried until migrated by an owning change.
 */
export function deriveBranchMergedState(
  input: BranchMergedStateInput
): BranchMergedState {
  if (input.connectedPrState === GitHubPRState.Merged) {
    return BranchMergedState.Merged;
  }
  if (input.connectedMergedAt) {
    return BranchMergedState.Merged;
  }
  if (input.hasConnectedPrEvidence) {
    return BranchMergedState.NotMerged;
  }
  if (input.localArtifactStatus === GitHubPRState.Merged) {
    return BranchMergedState.Merged;
  }
  if (
    input.localArtifactStatus === GitHubPRState.Open ||
    input.localArtifactStatus === GitHubPRState.Closed
  ) {
    return BranchMergedState.NotMerged;
  }
  return BranchMergedState.Unknown;
}
