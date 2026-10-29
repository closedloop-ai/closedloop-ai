import type { Meta, StoryObj } from "@storybook/react";
import { DocumentArtifactTabDemo } from "./v2-document-detail-tabs";

// The Document Detail page's Artifact Tab body (PRD-751, ISS-12586): the
// canvas toolbar the Issue page has too (Nerys, 2026-10-22; Composites/Labs/
// Documents/Document Detail/Toolbar), its text controls always on, then the
// document body at its natural height, with no scroller of its own.
// The finished page is Surfaces/Labs/Documents/Document Detail.
//
// Controls are disabled: the body reads the page's fixture document.

const meta = {
  title: "Composites/Labs/Documents/Document Detail/Artifact Tab",
  tags: ["preview"],
  render: () => <DocumentArtifactTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
