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
 * A card listing recent updates across a person's agent sessions: each row
 * shows the session's name, a status badge, a short summary, and how long
 * ago it happened. Use it as a quick activity digest instead of sending
 * someone to the full sessions list, since it only ever shows recent
 * movement rather than every session ever run. Each row's name links to that
 * session's detail page when a link builder is supplied, and falls back to
 * plain text when it isn't. The feed shows a loading skeleton while sessions
 * are still loading, a plain 'temporarily unavailable' message if the fetch
 * fails, and an honest empty state when there's genuinely no synced activity
 * yet.
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
