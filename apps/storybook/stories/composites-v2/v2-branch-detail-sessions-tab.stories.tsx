import type { Meta, StoryObj } from "@storybook/react";
import { BranchSessionsTabDemo } from "./v2-branch-detail-tabs";

// The Branch Detail page's Sessions tab body (PRD-751): the live Sessions &
// timeline panel the Branch shell mounts, the PR timeline (cost by owner,
// event dots, cost, peak bucket, LOC/$, group by) and the combined session
// trace, over a full example (Nerys, 2026-10-22): four sessions with prompts,
// replies, tool runs with a failure, subagents, git, review and error events,
// an idle gap, and new, resumed and CI starts.
// The finished page is Surfaces/Artifacts/Branches/Branch Detail.
//
// Controls are disabled: the body reads the page's fixture branch.

const meta = {
  title: "Composites/Artifacts/Branches/Branch Detail/Sessions Tab",
  tags: ["stable"],
  render: () => <BranchSessionsTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
