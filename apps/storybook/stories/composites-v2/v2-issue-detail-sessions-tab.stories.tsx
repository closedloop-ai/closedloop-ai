import type { Meta, StoryObj } from "@storybook/react";
import { IssueSessionsTabDemo } from "./v2-issue-detail-tabs";

// The Issue Detail page's Sessions Tab body (PRD-751, ISS-12586): the shipped Document Sessions panel: the sessions that
// wrote to or commented on the issue, over the full example the Branch page's
// Sessions tab shows too (Nerys, 2026-10-22): four sessions with every element
// the trace draws.
// The finished page is Surfaces/Labs/Issues/Issue Detail.
//
// Controls are disabled: the body reads the page's fixture issue.

const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Sessions Tab",
  tags: ["preview"],
  render: () => <IssueSessionsTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
