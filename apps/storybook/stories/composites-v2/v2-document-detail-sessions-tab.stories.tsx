import type { Meta, StoryObj } from "@storybook/react";
import { DocumentSessionsTabDemo } from "./v2-document-detail-tabs";

// The Document Detail page's Sessions Tab body (PRD-751, ISS-12586): the shipped Document Sessions panel: the sessions that
// wrote to or commented on the document, over the full example the Branch page's
// Sessions tab shows too (Nerys, 2026-10-22): four sessions with every element
// the trace draws.
// The finished page is Surfaces/Labs/Documents/Document Detail.
//
// Controls are disabled: the body reads the page's fixture document.

const meta = {
  title: "Composites/Labs/Documents/Document Detail/Sessions Tab",
  tags: ["preview"],
  render: () => <DocumentSessionsTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
