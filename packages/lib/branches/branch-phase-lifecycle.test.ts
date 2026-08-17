import {
  type BranchAssociatedPullRequestCollection,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { describe, expect, it } from "vitest";
import { branchPhaseLifecycleFromAssociatedPullRequests } from "./branch-phase-lifecycle";

describe("branchPhaseLifecycleFromAssociatedPullRequests", () => {
  it("preserves a folded close and marks later writes ambiguous", () => {
    const openedAt = "2026-08-01T10:00:00.000Z";
    const closedAt = "2026-08-02T10:00:00.000Z";
    const result = branchPhaseLifecycleFromAssociatedPullRequests(
      collection({ openedAt, closedAt, state: GitHubPRState.Open })
    );

    expect(result).toEqual({
      pullRequestCycles: [
        { pullRequestId: "acme/web#42", openedAt, terminalAt: closedAt },
      ],
      ambiguousWriteAfter: [closedAt],
    });
  });

  it("maps an ordinary active pull request to one open cycle", () => {
    const openedAt = "2026-08-01T10:00:00.000Z";
    const result = branchPhaseLifecycleFromAssociatedPullRequests(
      collection({ openedAt, closedAt: null, state: GitHubPRState.Open })
    );

    expect(result).toEqual({
      pullRequestCycles: [
        { pullRequestId: "acme/web#42", openedAt, terminalAt: null },
      ],
      ambiguousWriteAfter: [],
    });
  });
});

function collection(
  lifecycle: Pick<
    BranchAssociatedPullRequestCollection["items"][number],
    "closedAt" | "openedAt" | "state"
  >
): BranchAssociatedPullRequestCollection {
  return {
    items: [
      {
        id: "acme/web#42",
        repositoryFullName: "acme/web",
        number: 42,
        title: null,
        url: null,
        isDraft: false,
        reviewDecision: null,
        mergedAt: null,
        ...lifecycle,
      },
    ],
    selectedId: "acme/web#42",
    selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
    completeness: {
      state: BranchAssociatedPullRequestCompletenessState.Complete,
      reasons: [],
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
    },
  };
}
