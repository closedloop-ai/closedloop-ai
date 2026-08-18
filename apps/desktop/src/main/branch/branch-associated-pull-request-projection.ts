import {
  type BranchPrState,
  type BranchRow,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestProvenance,
  type BranchAssociatedPullRequestSelection,
  BranchAssociatedPullRequestSelectionReason,
  type BranchSelectedPullRequestIdentity,
  selectBranchAssociatedPullRequests,
} from "@repo/api/src/types/branch-associated-pull-request";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { BranchPrRow } from "../database/branch-reads.js";

export type DesktopAssociatedPullRequestCandidate = Omit<
  BranchPrRow,
  "state"
> & {
  repositoryFullName: string | null;
  number: number | null;
  url: string | null;
  state: BranchPrState | null;
  reviewDecision: null;
};

/** Project every persisted Desktop PR row through the shared selector. */
export function projectDesktopBranchAssociatedPullRequests(
  rows: readonly BranchPrRow[]
): BranchAssociatedPullRequestSelection<DesktopAssociatedPullRequestCandidate> {
  return selectBranchAssociatedPullRequests(
    rows.map((row) => ({
      ...row,
      repositoryFullName: row.repoFullName,
      number: row.prNumber,
      url: row.prUrl,
      state: deriveDesktopPrState(row),
      reviewDecision: null,
    })),
    BranchAssociatedPullRequestProvenance.PersistedDesktop
  );
}

/**
 * Resolve an explicit selection only from locally persisted associated PR rows.
 * Omission preserves the deterministic shared default; a foreign identity fails
 * closed so the renderer can never label the default PR as the requested one.
 */
export function resolveDesktopBranchAssociatedPullRequest(
  rows: readonly BranchPrRow[],
  selection: BranchAssociatedPullRequestSelection<DesktopAssociatedPullRequestCandidate>,
  requested?: BranchSelectedPullRequestIdentity
): BranchAssociatedPullRequestSelection<DesktopAssociatedPullRequestCandidate> | null {
  if (!requested) {
    return selection;
  }
  const selected = selection.collection.items.find(
    (candidate) =>
      candidate.repositoryFullName === requested.repositoryFullName &&
      candidate.number === requested.pullRequestNumber
  );
  if (!selected) {
    return null;
  }
  const persisted = projectDesktopBranchAssociatedPullRequests(
    rows.filter(
      (row) =>
        normalizeRepoFullName(row.repoFullName ?? "") ===
          selected.repositoryFullName && row.prNumber === selected.number
    )
  ).selected;
  if (!persisted) {
    return null;
  }
  return {
    collection: {
      ...selection.collection,
      selectedId: selected.id,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Explicit,
    },
    selected: persisted,
  };
}

/** Preserve the existing Desktop Branch status vocabulary for the selected PR. */
export function statusForSelectedDesktopPullRequest(
  selected: DesktopAssociatedPullRequestCandidate | null
): BranchStatus {
  const state = selected?.state ?? null;
  if (state === GitHubPRState.Merged) {
    return BranchStatus.Merged;
  }
  if (state === GitHubPRState.Closed) {
    return BranchStatus.Closed;
  }
  if (selected?.isDraft) {
    return BranchStatus.Draft;
  }
  return state === GitHubPRState.Open ? BranchStatus.Open : BranchStatus.Draft;
}

/** Map raw Desktop lifecycle evidence without treating unknown values as open. */
export function deriveDesktopPrState(pr: BranchPrRow): BranchPrState | null {
  const state = pr.state?.toLowerCase() ?? null;
  if (pr.mergedAt != null || state === "merged") {
    return GitHubPRState.Merged;
  }
  if (state === "closed") {
    return GitHubPRState.Closed;
  }
  if (state === "open") {
    return GitHubPRState.Open;
  }
  return null;
}

/** Preserve the legacy warning while ignoring absent or malformed PR numbers. */
export function hasMultipleValidPullRequestNumbers(
  rows: readonly Pick<BranchPrRow, "prNumber">[]
): boolean {
  return (
    new Set(
      rows
        .map(({ prNumber }) => prNumber)
        .filter(
          (prNumber): prNumber is number =>
            Number.isInteger(prNumber) && (prNumber ?? 0) > 0
        )
    ).size > 1
  );
}

/** Apply the selected PR to legacy Branch list fields. */
export function selectedDesktopPullRequestFields(
  selected: DesktopAssociatedPullRequestCandidate | null
): Pick<
  BranchRow,
  "prNumber" | "prState" | "prTitle" | "prUrl" | "reviewDecision"
> {
  return {
    prNumber: selected?.prNumber ?? null,
    prState: selected?.state ?? null,
    prTitle: selected?.title ?? null,
    prUrl: selected?.prUrl ?? null,
    reviewDecision: null,
  };
}
