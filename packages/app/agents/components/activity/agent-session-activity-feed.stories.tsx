import type { Meta, StoryObj } from "@storybook/react";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { populatedAgentSessionListFixtures } from "../sessions/session-list-fixtures";
import { AgentSessionActivityFeed } from "./agent-session-activity-feed";

const meta: Meta<typeof AgentSessionActivityFeed> = {
  component: AgentSessionActivityFeed,
  decorators: [
    (Story) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions",
            respond: () => ({
              items: populatedAgentSessionListFixtures,
              total: populatedAgentSessionListFixtures.length,
              viewerScope: "self",
            }),
          },
        ]}
      >
        <Story />
      </AppCoreStoryProviders>
    ),
  ],
  title: "App Core/Agents/Session Activity Feed",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: {
    getSessionHref: (item) => `/sessions/${item.id}`,
  },
};
