import { ACTIVITY_QUERY_DATA } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchActivityTabDemo } from "./v2-branch-detail-tabs";

// The Branch Detail page's Activity tab body (PRD-751): the Branch feed, newest
// first, on the shared Activity timeline.
// The finished page is Surfaces/Artifacts/Branches/Branch Detail.
//
// Controls are disabled: the body reads the page's fixture branch.

const meta = {
  title: "Composites/Artifacts/Branches/Branch Detail/Activity Tab",
  tags: ["stable"],
  render: () => <BranchActivityTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { queryData: ACTIVITY_QUERY_DATA },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
