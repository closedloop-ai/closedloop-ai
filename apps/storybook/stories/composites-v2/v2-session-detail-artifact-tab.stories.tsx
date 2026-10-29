import type { Meta, StoryObj } from "@storybook/react";
import { SessionArtifactTabDemo } from "./v2-session-detail-tabs";

// The Session Detail page's Artifact tab body (PRD-751): the Session
// Timeline and the trace a timeline jump lands on, on the framed canvas
// (ISS-12403; the session's properties are its Details tab). As the live page
// has them (Nerys, 2026-10-22): the trace under its own "Session Trace"
// heading with the event count, and each turn's actor avatar in the gutter.
// The finished page is Surfaces/Artifacts/Sessions/Session Detail.
//
// Controls are disabled: the body reads the page's fixture session.

const meta = {
  title: "Composites/Artifacts/Sessions/Session Detail/Artifact Tab",
  tags: ["stable"],
  render: () => <SessionArtifactTabDemo />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };
