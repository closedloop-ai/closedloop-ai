import { BranchRowStatus } from "@repo/app/branches/lib/branch-row";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { BranchCellExamples, branchCellRow } from "./v2-branches-list-cells";

// The Branches list's Status cell (`renderBranchStatus` through the list's cell
// renderer): the branch's state, read from its pull request and review. Each
// state is a low-emphasis label except Changes requested, the one a reader acts
// on, which is a filled chip.
// The finished list is Surfaces/Artifacts/Branches/Branches List.

const STATES = [
  ["Open", BranchRowStatus.Open],
  ["In review", BranchRowStatus.Review],
  ["Changes requested", BranchRowStatus.Blocked],
  ["Merged", BranchRowStatus.Merged],
  ["Draft", BranchRowStatus.Draft],
  ["Closed", BranchRowStatus.Closed],
] as const;

const EXAMPLES = STATES.map(([state, status]) => ({
  state,
  row: branchCellRow(`status-${status}`, { status, rawStatus: status }),
}));

const meta = {
  title: "Composites/Artifacts/Branches/Branches List/Status Cell",
  tags: ["stable"],
  render: () => <BranchCellExamples columnId="status" examples={EXAMPLES} />,
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const [label, status] of STATES) {
      await expect(
        canvas.getByTestId(`branch-cell-status-${status}`)
      ).toHaveTextContent(label);
    }
  },
};

export const Dark: Story = { globals: { theme: "dark" } };
