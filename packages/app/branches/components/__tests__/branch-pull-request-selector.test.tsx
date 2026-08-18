import {
  type BranchAssociatedPullRequestCollection,
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchPullRequestSelector } from "../branch-pull-request-selector";

const BETA_OPTION_RE = /#42 Same number.*beta\/widgets.*Open/i;
const INCOMPLETE_DESCRIPTION_RE =
  /some pull request history couldn't be verified/i;
const UNAVAILABLE_DESCRIPTION_RE = /pull request history isn't available yet/i;

describe("BranchPullRequestSelector", () => {
  it("emits the exact repository-qualified identity for the selected PR", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <BranchPullRequestSelector
        collection={collection()}
        onChange={onChange}
        selectedId="alpha/widgets#42"
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Pull request" }));
    await user.click(screen.getByRole("option", { name: BETA_OPTION_RE }));

    expect(onChange).toHaveBeenCalledWith({
      repositoryFullName: "beta/widgets",
      pullRequestNumber: 42,
    });
  });

  it("discloses incomplete history without disabling known options", () => {
    render(
      <BranchPullRequestSelector
        collection={collection(
          BranchAssociatedPullRequestCompletenessState.Incomplete
        )}
        onChange={() => undefined}
        selectedId="alpha/widgets#42"
      />
    );

    expect(
      screen.getByRole("combobox", { name: "Pull request" })
    ).toBeEnabled();
    expect(screen.getByText(INCOMPLETE_DESCRIPTION_RE)).toBeInTheDocument();
  });

  it("disables an empty unavailable selector and explains the missing history", () => {
    const value = collection(
      BranchAssociatedPullRequestCompletenessState.Unavailable
    );
    value.items = [];
    value.selectedId = null;
    render(
      <BranchPullRequestSelector
        collection={value}
        onChange={() => undefined}
        selectedId={null}
      />
    );

    expect(
      screen.getByRole("combobox", { name: "Pull request" })
    ).toBeDisabled();
    expect(screen.getByText(UNAVAILABLE_DESCRIPTION_RE)).toBeInTheDocument();
  });
});

function collection(
  state: BranchAssociatedPullRequestCompletenessState = BranchAssociatedPullRequestCompletenessState.Complete
): BranchAssociatedPullRequestCollection {
  return {
    items: [pullRequest("alpha/widgets"), pullRequest("beta/widgets")],
    selectedId: "alpha/widgets#42",
    selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
    completeness: {
      state,
      reasons:
        state === BranchAssociatedPullRequestCompletenessState.Complete
          ? []
          : [BranchAssociatedPullRequestCompletenessReason.InvalidIdentity],
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
    },
  };
}

function pullRequest(repositoryFullName: string) {
  return {
    id: `${repositoryFullName}#42`,
    repositoryFullName,
    number: 42,
    title: "Same number",
    url: `https://github.com/${repositoryFullName}/pull/42`,
    state: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    openedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
  };
}
