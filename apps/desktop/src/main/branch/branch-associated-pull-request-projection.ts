import type {
  BranchPrState,
  BranchRow,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestProvenance,
  type BranchAssociatedPullRequestSelection,
  observedPullRequestState,
  selectBranchAssociatedPullRequests,
} from "@repo/api/src/types/branch-associated-pull-request";
import type { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { deriveBranchMergedState } from "@repo/api/src/types/branch-merged-state";
import { toBranchStatus } from "@repo/api/src/types/branch-status-derivation";
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
  reviewDecision: ReviewDecision | null;
  /**
   * ISS-8422 — `false` when no producer observed this PR's lifecycle. The
   * cloud-overlay producer sets it when the cloud refuses to state a `pr_state`;
   * local rows set it whenever {@link deriveDesktopPrState} returns null, which
   * is every local row now that Desktop stores no GitHub state.
   */
  lifecycleObserved?: boolean;
};

/** Map persisted Desktop rows into the shared associated-PR candidate contract. */
export function desktopAssociatedPullRequestCandidates(
  rows: readonly BranchPrRow[]
): DesktopAssociatedPullRequestCandidate[] {
  return rows.map((row) => {
    const derivedState = deriveDesktopPrState(row);
    return {
      ...row,
      repositoryFullName: row.repoFullName,
      number: row.prNumber,
      url: row.prUrl,
      // The shared selector admits a candidate only with a lifecycle, so a PR the
      // transcript named but nothing observed carries OPEN and says so with
      // `lifecycleObserved: false`, as the cloud-overlay candidate does.
      state: derivedState ?? GitHubPRState.Open,
      ...(derivedState === null ? { lifecycleObserved: false } : {}),
      reviewDecision: null,
    };
  });
}

/** Project every persisted Desktop PR row through the shared selector. */
export function projectDesktopBranchAssociatedPullRequests(
  rows: readonly BranchPrRow[]
): BranchAssociatedPullRequestSelection<DesktopAssociatedPullRequestCandidate> {
  return selectBranchAssociatedPullRequests(
    desktopAssociatedPullRequestCandidates(rows),
    BranchAssociatedPullRequestProvenance.PersistedDesktop
  );
}

/**
 * Derive this Desktop branch's status from the selected PR.
 *
 * ISS-9664: this is a THIN adapter over the shared {@link toBranchStatus} — the
 * one derivation both surfaces answer to — not a second copy of the rules. It
 * used to be its own ladder, and it disagreed with the cloud twice: a branch
 * with no PR evidence fell through to Draft where the cloud derives Open, and it
 * checked Closed above Draft so a closed draft read Closed here and Draft there.
 *
 * `artifactStatus` is `null` because this store has no branch-owned lifecycle
 * column to read; the shared derivation takes that absence rather than a
 * substituted value. `isDraft` is forced to `false` when nothing observed the
 * PR: ISS-8422 makes an unobserved PR derive as if no PR were connected, and a
 * draft flag on a PR nobody observed is not evidence the branch is a draft.
 */
export function statusForSelectedDesktopPullRequest(
  selected: DesktopAssociatedPullRequestCandidate | null
): BranchStatus {
  const state = observedPullRequestState(selected);
  const hasObservedPr = state !== null;
  return toBranchStatus(
    null,
    state,
    hasObservedPr && selected?.isDraft === true,
    deriveBranchMergedState({
      connectedPrState: state,
      // The desktop `state` is ALREADY merge-aware (`deriveDesktopPrState` folds
      // `mergedAt` into it), so the timestamp is passed only so this adapter
      // states the same evidence the cloud one does rather than relying on that
      // fold staying true.
      connectedMergedAt: hasObservedPr ? (selected?.mergedAt ?? null) : null,
      hasConnectedPrEvidence: hasObservedPr,
    })
  );
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
    // ISS-8422: the number and URL survive so the row still links out, the
    // state does not, and `BranchPRBadge` renders that pair as "Unconfirmed".
    prState: observedPullRequestState(selected),
    prTitle: selected?.title ?? null,
    prUrl: selected?.prUrl ?? null,
    reviewDecision: selected?.reviewDecision ?? null,
  };
}
