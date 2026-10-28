import { GitHubPRState } from "@repo/api/src/types/github";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LINKED_WORK_DATA_PENDING,
  LINKED_WORK_FIELD_SOURCES,
  LinkedWorkBranchState,
  LinkedWorkCard,
  linkedWorkBranchState,
} from "../linked-work-card";
import {
  BRANCH_CLOSED,
  BRANCH_IN_PROGRESS,
  BRANCH_IN_REVIEW,
  BRANCH_MERGED,
  BRANCH_ON_SUB_ISSUE,
  BRANCH_UNCONFIRMED,
} from "../linked-work-card.fixtures";

/**
 * ISS-12580 (DI-10): the issue canvas's Branch section shows each branch's
 * state, read from its pull request, its checks and its changes, and nothing
 * whose source is not settled (Ottilie, 2026-10-21).
 */
describe("LinkedWorkCard (ISS-12580)", () => {
  it("reads a branch's state from its pull request", () => {
    expect(linkedWorkBranchState(null)).toBe(LinkedWorkBranchState.InProgress);
    expect(linkedWorkBranchState({ state: GitHubPRState.Open })).toBe(
      LinkedWorkBranchState.InReview
    );
    expect(linkedWorkBranchState({ state: GitHubPRState.Merged })).toBe(
      LinkedWorkBranchState.Merged
    );
    expect(linkedWorkBranchState({ state: GitHubPRState.Closed })).toBe(
      LinkedWorkBranchState.ClosedWithoutMerge
    );
    expect(linkedWorkBranchState({ state: null })).toBe(
      LinkedWorkBranchState.Unconfirmed
    );
  });

  it("names every branch with its state, and links the branch record", () => {
    render(
      <LinkedWorkCard
        branches={[
          BRANCH_IN_PROGRESS,
          BRANCH_IN_REVIEW,
          BRANCH_MERGED,
          BRANCH_CLOSED,
        ]}
      />
    );
    const branches = within(
      screen.getByRole("list", { name: "Branches" })
    ).getAllByRole("article");
    expect(branches.map((branch) => branch.textContent)).toEqual([
      expect.stringContaining("In progress"),
      expect.stringContaining("In review"),
      expect.stringContaining("Merged"),
      expect.stringContaining("Closed without merge"),
    ]);
    expect(
      screen.getByRole("link", { name: BRANCH_IN_REVIEW.name })
    ).toHaveAttribute("href", BRANCH_IN_REVIEW.href);
  });

  it("says Unconfirmed, as the PR badge does, for a pull request with no state", () => {
    render(<LinkedWorkCard branches={[BRANCH_UNCONFIRMED]} />);
    const branch = screen.getByRole("article", {
      name: BRANCH_UNCONFIRMED.name,
    });
    expect(branch).not.toHaveTextContent("In progress");
    // Once on the state chip, once on the badge beside it.
    expect(within(branch).getAllByText("Unconfirmed")).toHaveLength(2);
  });

  it("says a branch implements a sub-issue", () => {
    render(<LinkedWorkCard branches={[BRANCH_ON_SUB_ISSUE]} />);
    expect(screen.getByRole("link", { name: "ISS-12579" })).toHaveAttribute(
      "href",
      "/issues/ISS-12579"
    );
  });

  it("marks the description and the Storybook preview as data pending", () => {
    render(<LinkedWorkCard branches={[BRANCH_IN_REVIEW]} />);
    const branch = screen.getByRole("article", { name: BRANCH_IN_REVIEW.name });
    expect(within(branch).getByText("Description")).toBeInTheDocument();
    expect(within(branch).getByText("Storybook preview")).toBeInTheDocument();
    expect(within(branch).getAllByText(LINKED_WORK_DATA_PENDING)).toHaveLength(
      2
    );
  });

  it("labels every field with its data source only when asked", () => {
    const { rerender } = render(
      <LinkedWorkCard branches={[BRANCH_ON_SUB_ISSUE]} />
    );
    expect(
      screen.queryByText(LINKED_WORK_FIELD_SOURCES.checks)
    ).not.toBeInTheDocument();
    rerender(<LinkedWorkCard branches={[BRANCH_ON_SUB_ISSUE]} showSources />);
    for (const source of Object.values(LINKED_WORK_FIELD_SOURCES)) {
      expect(screen.getByText(source)).toBeInTheDocument();
    }
  });

  it("says there is no branch yet", () => {
    render(<LinkedWorkCard branches={[]} />);
    expect(screen.getByText("No branch yet")).toBeInTheDocument();
  });
});
