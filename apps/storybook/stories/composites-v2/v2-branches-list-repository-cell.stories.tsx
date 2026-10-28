import { RENDER_MISSING } from "@repo/app/branches/lib/branch-row";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { BranchCellExamples, branchCellRow } from "./v2-branches-list-cells";

// The Branches list's Repository cell: the repository the branch lives in,
// linking to it on GitHub. It names a repository by its short name, and adds
// the owner only when two repositories on the list share that name. A branch
// whose repository is unknown shows the unavailable value.
// The finished list is Surfaces/Artifacts/Branches/Branches List.

const EXAMPLES = [
  {
    state: "Unique name",
    row: branchCellRow("repo-unique", { repo: "closedloop-ai/closedloop-ai" }),
  },
  {
    state: "Shared name, first owner",
    row: branchCellRow("repo-shared-a", { repo: "closedloop-ai/web" }),
  },
  {
    state: "Shared name, second owner",
    row: branchCellRow("repo-shared-b", { repo: "acme/web" }),
  },
  {
    state: "Unknown repository",
    row: branchCellRow("repo-missing", { repo: RENDER_MISSING }),
  },
];

const meta = {
  title: "Composites/Artifacts/Branches/Branches List/Repository Cell",
  tags: ["stable"],
  render: () => <BranchCellExamples columnId="repo" examples={EXAMPLES} />,
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("branch-cell-header")).toHaveTextContent(
      "Repository"
    );
    await expect(
      canvas.getByTestId("branch-cell-repo-unique")
    ).toHaveTextContent("closedloop-ai");
  },
};

export const Dark: Story = { globals: { theme: "dark" } };
