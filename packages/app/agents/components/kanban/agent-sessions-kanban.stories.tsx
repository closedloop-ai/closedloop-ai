import type { Meta, StoryObj } from "@storybook/react";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { populatedAgentSessionListFixtures } from "../sessions/session-list-fixtures";
import { AgentSessionsKanban } from "./agent-sessions-kanban";

const meta: Meta<typeof AgentSessionsKanban> = {
  component: AgentSessionsKanban,
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
  title: "App Core/Agents/Sessions Kanban",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: {
    getSessionHref: (item) => `/sessions/${item.id}`,
  },
};
