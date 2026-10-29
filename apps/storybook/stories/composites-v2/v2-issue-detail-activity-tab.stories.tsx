import { ACTIVITY_QUERY_DATA } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import type { Meta, StoryObj } from "@storybook/react";
import { IssueActivityTabDemo } from "./v2-issue-detail-tabs";

// The Issue Detail page's Activity Tab body (PRD-751, ISS-12586): the Issue feed, newest first, on the shared Activity timeline.
// The finished page is Surfaces/Labs/Issues/Issue Detail.
//
// Controls are disabled: the body reads the page's fixture issue.

const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Activity Tab",
  tags: ["preview"],
  render: () => <IssueActivityTabDemo />,
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
