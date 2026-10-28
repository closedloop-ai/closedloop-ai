import type { Meta, StoryObj } from "@storybook/react";
import { DocumentDetailsTabDemo } from "./v2-document-detail-tabs";

// The Document Detail page's Details Tab body (PRD-751, ISS-12586): the shared Details sections for a Document (Current version as
// Document details, PRD-799).
// The finished page is Surfaces/Labs/Documents/Document Detail.
//
// Controls are disabled: the body reads the page's fixture document.

const meta = {
  title: "Composites/Labs/Documents/Document Detail/Details Tab",
  tags: ["preview"],
  render: () => <DocumentDetailsTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
