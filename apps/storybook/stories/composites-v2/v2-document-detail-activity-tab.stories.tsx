import { ACTIVITY_QUERY_DATA } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import type { Meta, StoryObj } from "@storybook/react";
import { DocumentActivityTabDemo } from "./v2-document-detail-tabs";

// The Document Detail page's Activity Tab body (PRD-751, ISS-12586): the Document feed, newest first, on the shared Activity timeline.
// The finished page is Surfaces/Labs/Documents/Document Detail.
//
// Controls are disabled: the body reads the page's fixture document.

const meta = {
  title: "Composites/Labs/Documents/Document Detail/Activity Tab",
  tags: ["preview"],
  render: () => <DocumentActivityTabDemo />,
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
