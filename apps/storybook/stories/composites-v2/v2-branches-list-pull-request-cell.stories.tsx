import { GitHubPRState } from "@repo/api/src/types/github-status";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { pr } from "../surfaces-v2/fixtures/branches-list-fixtures";
import { BranchCellExamples, branchCellRow } from "./v2-branches-list-cells";

// The Branches list's Pull request cell (`BranchPRBadge` through the list's
// cell renderer): the branch's pull request, coloured by its state, linking to
// GitHub. A number with no observed state says so in words (ISS-8422); a branch
// with no pull request shows the empty value.
// The finished list is Surfaces/Artifacts/Branches/Branches List.

const PR_URL = "https://github.com/closedloop-ai/closedloop-ai/pull";

const REPO = "closedloop-ai/closedloop-ai";

function prRow(
  id: string,
  prNumber: number | null,
  prState: GitHubPRState | null
) {
  const link =
    prNumber == null
      ? { prNumber: null, prState: null, prTitle: null, prUrl: null }
      : pr(prNumber, `Story pull request ${prNumber}`, prState, REPO);
  return branchCellRow(id, {
    ...link,
    repo: REPO,
    prRepo: prNumber == null ? null : REPO,
  });
}

const EXAMPLES = [
  { state: "Open", row: prRow("pr-open", 7031, GitHubPRState.Open) },
  { state: "Merged", row: prRow("pr-merged", 6988, GitHubPRState.Merged) },
  { state: "Closed", row: prRow("pr-closed", 6950, GitHubPRState.Closed) },
  { state: "State not observed", row: prRow("pr-unobserved", 7012, null) },
  { state: "No pull request", row: prRow("pr-none", null, null) },
];

const meta = {
  title: "Composites/Artifacts/Branches/Branches List/Pull Request Cell",
  tags: ["stable"],
  render: () => <BranchCellExamples columnId="pr" examples={EXAMPLES} />,
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("branch-cell-header")).toHaveTextContent(
      "Pull request"
    );
    await expect(
      within(canvas.getByTestId("branch-cell-pr-open")).getByRole("link")
    ).toHaveAttribute("href", `${PR_URL}/7031`);
    await expect(
      within(canvas.getByTestId("branch-cell-pr-none")).queryByRole("link")
    ).toBeNull();
  },
};

export const Dark: Story = { globals: { theme: "dark" } };
