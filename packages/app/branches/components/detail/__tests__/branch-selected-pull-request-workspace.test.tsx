import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { BranchSelectedPullRequestWorkspace } from "../branch-selected-pull-request-workspace";

vi.mock("../../../hooks/use-branch-selected-pull-request-files", () => ({
  useBranchSelectedPullRequestFiles: () => ({
    data: undefined,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../hooks/use-branches", () => ({
  useBranchComments: () => ({
    data: undefined,
    isError: false,
    isLoading: false,
  }),
  useBranchDetail: (_id: string, options: { enabled: boolean }) => ({
    data: undefined,
    isError: options.enabled,
    isFetching: false,
    isPending: false,
    isSuccess: false,
  }),
}));

describe("BranchSelectedPullRequestWorkspace", () => {
  it("keeps Branch-owned cost visible without rendering the wrong PR when an explicit read fails", () => {
    render(
      <BranchSelectedPullRequestWorkspace
        branchId="branch-1"
        detail={detail()}
        selection={{
          repositoryFullName: "octo/repo",
          pullRequestNumber: 43,
        }}
      />
    );

    expect(
      screen.getByText("Pull request details unavailable")
    ).toBeInTheDocument();
    expect(screen.getByText("Cost breakdown")).toBeInTheDocument();
    expect(screen.queryByText("Current description")).not.toBeInTheDocument();
    expect(screen.queryByText("Files changed")).not.toBeInTheDocument();
  });
});

function detail() {
  const first = pullRequest(42, "Current selection");
  const second = pullRequest(43, "Unavailable selection");
  return makeBranchDetail({
    id: "branch-1",
    associatedPullRequests: {
      items: [first, second],
      selectedId: first.id,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Complete,
        reasons: [],
        provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
      },
    },
    selectedPullRequest: {
      ...first,
      body: "Current description",
      headRefOid: "a".repeat(40),
      mergeCommitSha: null,
      changedFiles: 1,
      additions: 1,
      deletions: 1,
    },
  });
}

function pullRequest(number: number, title: string) {
  return {
    id: `octo/repo#${number}`,
    repositoryFullName: "octo/repo",
    number,
    title,
    url: `https://github.com/octo/repo/pull/${number}`,
    state: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    openedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
  };
}
