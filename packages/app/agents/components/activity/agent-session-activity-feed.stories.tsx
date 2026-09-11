import type { Meta, StoryObj } from "@storybook/react";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import { populatedAgentSessionListFixtures } from "../sessions/session-list-fixtures";
import { AgentSessionActivityFeed } from "./agent-session-activity-feed";

const storyApiRoutes: FixtureRoute[] = [
  {
    method: "GET",
    path: "/agent-sessions",
    respond: () => ({
      items: populatedAgentSessionListFixtures,
      total: populatedAgentSessionListFixtures.length,
      viewerScope: "self",
    }),
  },
];

/**
 * A card listing recent updates across a person's agent sessions, for a
 * quick activity digest instead of sending them to the full sessions list to
 * see what's moved.
 */
const meta: Meta<typeof AgentSessionActivityFeed> = {
  component: AgentSessionActivityFeed,
  tags: ["autodocs"],
  argTypes: {
    getSessionHref: {
      control: false,
      description:
        "Builds the href for one activity row. Omitted, rows render without a link.",
    },
  },
  parameters: { appCore: { apiRoutes: storyApiRoutes } },
  title: "Composites/Sessions/Detail/Session Activity Feed",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: {
    getSessionHref: (item) => `/sessions/${item.id}`,
  },
};
