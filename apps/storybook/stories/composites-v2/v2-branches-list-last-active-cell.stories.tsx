import { RENDER_MISSING } from "@repo/app/branches/lib/branch-row";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { BranchCellExamples, branchCellRow } from "./v2-branches-list-cells";

// The Branches list's Last active cell: when the branch last had genuine
// activity (a push, a pull request event, a linked session), as a relative
// time. A branch with no recorded activity shows the unavailable value.
// The finished list is Surfaces/Artifacts/Branches/Branches List.

const MINUTE_MS = 60 * 1000;
const NOW_MS = Date.now();

/**
 * A row active `minutesAgo` before now, labelled the way the production
 * wire-to-row adapter labels it (`branch-row-adapter.ts`: `formatRelativeTime`).
 */
function activeRow(id: string, minutesAgo: number) {
  const at = new Date(NOW_MS - minutesAgo * MINUTE_MS);
  return branchCellRow(id, {
    lastActivityAt: at.toISOString(),
    lastActivityLabel: formatRelativeTime(at, { now: NOW_MS }),
  });
}

const EXAMPLES = [
  { state: "Within the hour", row: activeRow("active-recent", 30) },
  { state: "Hours ago", row: activeRow("active-hours", 2 * 60) },
  { state: "Days ago", row: activeRow("active-days", 3 * 24 * 60) },
  {
    // The adapter's value for a branch with no activity timestamp.
    state: "No recorded activity",
    row: branchCellRow("active-unavailable", {
      lastActivityAt: undefined,
      lastActivityLabel: RENDER_MISSING,
    }),
  },
];

const meta = {
  title: "Composites/Artifacts/Branches/Branches List/Last Active Cell",
  tags: ["stable"],
  render: () => (
    <BranchCellExamples columnId="lastActivity" examples={EXAMPLES} />
  ),
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("branch-cell-header")).toHaveTextContent(
      "Last active"
    );
    // The production wording, spelled out so a change to it shows up here.
    await expect(
      canvas.getByTestId("branch-cell-active-recent")
    ).toHaveTextContent("30 min ago");
    await expect(
      canvas.getByTestId("branch-cell-active-hours")
    ).toHaveTextContent("2 hours ago");
    await expect(
      canvas.getByTestId("branch-cell-active-days")
    ).toHaveTextContent("3 days ago");
    await expect(
      canvas.getByTestId("branch-cell-active-unavailable")
    ).toHaveTextContent("Unavailable");
  },
};

export const Dark: Story = { globals: { theme: "dark" } };
