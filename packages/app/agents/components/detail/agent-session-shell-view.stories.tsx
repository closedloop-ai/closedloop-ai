import type { Meta, StoryObj } from "@storybook/react";
import { populatedAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import { AgentSessionShellView } from "./agent-session-shell-view";

const meta: Meta<typeof AgentSessionShellView> = {
  title: "Surfaces v1.0/Sessions/Agent Session Shell View",
  tags: ["deprecated"],
  component: AgentSessionShellView,
  parameters: {
    layout: "fullscreen",
    // These composed-screen fixtures keep states in separate stories.
    controls: { disable: true },
  },
  decorators: [
    (Story) => (
      <div className="flex h-screen min-h-0 flex-col bg-background">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
};

export const Loading: Story = {
  args: { backHref: "/sessions", isLoading: true },
};

export const NotFound: Story = {
  args: { backHref: "/sessions", isLoading: false },
};

export const ProviderError: Story = {
  args: { backHref: "/sessions", isLoading: false, isError: true },
};
