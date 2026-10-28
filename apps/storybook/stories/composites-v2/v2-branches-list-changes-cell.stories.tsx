import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { BranchCellExamples, branchCellRow } from "./v2-branches-list-cells";

// The Branches list's Changes cell (`BranchChangesBar` through the list's cell
// renderer): lines added and deleted on the branch, with a bar for their
// balance. Lines GitHub has not reported show the unavailable value, never 0.
// The finished list is Surfaces/Artifacts/Branches/Branches List.

const EXAMPLES = [
  {
    state: "Additions and deletions",
    row: branchCellRow("changes-mixed", { additions: 412, deletions: 96 }),
  },
  {
    state: "Additions only",
    row: branchCellRow("changes-added", { additions: 268, deletions: 0 }),
  },
  {
    state: "Deletions only",
    row: branchCellRow("changes-deleted", { additions: 0, deletions: 140 }),
  },
  {
    state: "Not reported",
    row: branchCellRow("changes-unavailable", {
      additions: null,
      deletions: null,
    }),
  },
];

const meta = {
  title: "Composites/Artifacts/Branches/Branches List/Changes Cell",
  tags: ["stable"],
  render: () => <BranchCellExamples columnId="changes" examples={EXAMPLES} />,
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByTestId("branch-cell-changes-mixed")
    ).toHaveTextContent("412");
    await expect(
      canvas.getByTestId("branch-cell-changes-unavailable")
    ).not.toHaveTextContent("0");
  },
};

export const Dark: Story = { globals: { theme: "dark" } };
