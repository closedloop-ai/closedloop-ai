import type { Meta, StoryObj } from "@storybook/react";
import { IssueDetailsTabDemo } from "./v2-issue-detail-tabs";

// The Issue Detail page's Details Tab body (PRD-751, ISS-12586): the shared Details sections for an Issue (the Issue details
// group). It shows the canvas toolbar's fields with more room, and the
// issue's related artifacts and external links (Ottilie, 2026-10-21); there is
// no toolbar on this tab.
// The finished page is Surfaces/Labs/Issues/Issue Detail.
//
// Controls are disabled: the body reads the page's fixture issue.

const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Details Tab",
  tags: ["preview"],
  render: () => <IssueDetailsTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
