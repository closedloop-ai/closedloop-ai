import type { Meta, StoryObj } from "@storybook/react";
import { SessionDetailsTabDemo } from "./v2-session-detail-tabs";

// The Session Detail page's Details tab body (PRD-751): the shared Details
// sections for the Session.
// The finished page is Surfaces/Artifacts/Sessions/Session Detail.
//
// Controls are disabled: the body reads the page's fixture session.

const meta = {
  title: "Composites/Artifacts/Sessions/Session Detail/Details Tab",
  tags: ["stable"],
  render: () => <SessionDetailsTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
