import type { Meta, StoryObj } from "@storybook/react";
import { BranchDetailsTabDemo } from "./v2-branch-detail-tabs";

// The Branch Detail page's Details tab body (PRD-751): the shared Details
// sections for the Branch.
// The finished page is Surfaces/Artifacts/Branches/Branch Detail.
//
// Controls are disabled: the body reads the page's fixture branch.

const meta = {
  title: "Composites/Artifacts/Branches/Branch Detail/Details Tab",
  tags: ["stable"],
  render: () => <BranchDetailsTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
