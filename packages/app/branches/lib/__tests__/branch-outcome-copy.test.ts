import type {
  BranchAssociatedPullRequest,
  BranchAssociatedPullRequestCollection,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { describe, expect, it } from "vitest";
import {
  BRANCH_PULL_REQUEST_HISTORY_UNAVAILABLE,
  branchPullRequestCycleAbsence,
} from "../branch-outcome-copy";

/**
 * ISS-6957. The whole matrix, each state asserted as ITSELF — a test proving
 * only "it no longer says 'Evidence is unavailable.'" would pass while every
 * absent state still rendered identically, which is the defect, not the fix.
 */
describe("branchPullRequestCycleAbsence", () => {
  it("defers to the caller's own availability copy when a PR is selected", () => {
    expect(branchPullRequestCycleAbsence(collection(), true)).toBeNull();
    expect(branchPullRequestCycleAbsence(undefined, true)).toBeNull();
  });

  it("names the unselected pull request as the reason, and points at the control", () => {
    expect(branchPullRequestCycleAbsence(collection([item()]), false)).toEqual({
      detail: "Select a pull request to see this.",
      label: "No PR selected",
    });
  });

  it("calls a branch that provably has no pull request not applicable", () => {
    expect(branchPullRequestCycleAbsence(collection([]), false)).toEqual({
      detail: "This branch has no pull request.",
      label: "N/A",
    });
  });

  it("keeps unreadable pull-request history an outage, not an action", () => {
    const unreadable = collection(
      [],
      BranchAssociatedPullRequestCompletenessState.Unavailable
    );

    expect(branchPullRequestCycleAbsence(unreadable, false)).toEqual({
      detail: BRANCH_PULL_REQUEST_HISTORY_UNAVAILABLE,
      label: "Unavailable",
    });
    expect(branchPullRequestCycleAbsence(undefined, false)).toEqual({
      detail: BRANCH_PULL_REQUEST_HISTORY_UNAVAILABLE,
      label: "Unavailable",
    });
  });

  /**
   * The guard the ticket is actually about: three different reasons must not
   * collapse into one sentence. Without this, a future edit could route all
   * three through a single string and every case above would still pass.
   */
  it("gives the three absent states three distinct sentences", () => {
    const sentences = [
      branchPullRequestCycleAbsence(collection([item()]), false)?.detail,
      branchPullRequestCycleAbsence(collection([]), false)?.detail,
      branchPullRequestCycleAbsence(undefined, false)?.detail,
    ];

    expect(new Set(sentences).size).toBe(3);
  });

  /**
   * Codex review on PR #6194. Desktop's
   * `suppressMismatchedSelectedPullRequest` answers version skew — a newer
   * renderer asking an older main for an explicit pull request it ignores — by
   * nulling the PR projection and the cycle metrics while leaving the collection
   * standing, `selectedId` included. Reading the projection alone reports that
   * reader as one who has not selected a pull request and offers an action that
   * changes nothing; the collection's own `selectedId` keeps it an outage.
   */
  it("keeps a suppressed selection an outage rather than an unmade choice", () => {
    const suppressed = { ...collection([item()]), selectedId: item().id };

    expect(branchPullRequestCycleAbsence(suppressed, false)).toBeNull();
  });

  /**
   * The counterpart, and the reason the case above is not simply "trust the
   * collection": a collection that holds pull requests and has selected NONE is
   * the reader's unmade choice, which is the sentence ISS-6957 exists to add.
   */
  it("still names the unselected pull request when nothing is selected", () => {
    expect(branchPullRequestCycleAbsence(collection([item()]), false)).toEqual({
      detail: "Select a pull request to see this.",
      label: "No PR selected",
    });
  });
});

function item(): BranchAssociatedPullRequest {
  return {
    id: "acme/web#42",
    repositoryFullName: "acme/web",
    number: 42,
    title: "Selectable PR",
    url: "https://github.com/acme/web/pull/42",
    state: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    openedAt: null,
    closedAt: null,
    mergedAt: null,
  };
}

function collection(
  items: readonly BranchAssociatedPullRequest[] = [],
  state: BranchAssociatedPullRequestCompletenessState = BranchAssociatedPullRequestCompletenessState.Complete
): BranchAssociatedPullRequestCollection {
  return {
    items,
    selectedId: null,
    selectionReason: BranchAssociatedPullRequestSelectionReason.Ambiguous,
    completeness: {
      state,
      reasons: [],
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
    },
  };
}
