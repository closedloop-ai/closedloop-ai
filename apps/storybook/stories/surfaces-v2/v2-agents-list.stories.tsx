import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { KIND_META } from "@repo/app/agents/lib/component-meta";
import {
  AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY,
  AGENTS_NAV_FEATURE_FLAG_KEY,
  AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import AgentsPage from "@/app/(authenticated)/[orgSlug]/agents/page";
import {
  agentComponentsFixture,
  agentsApiRoutes,
  agentsListRoute,
} from "./fixtures/agents-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar, entry 11 of 62: Agents List (Artifact list).
// The live route's own page (`apps/app/.../agents/page.tsx`: the route gate,
// Header and `AgentsListHost`) in the app frame. The route is gated on
// `agentsNav` and the host mounts `AgentsListSurfaceV2` behind
// `agent-ops-complete-surface` (100% rollout, 2026-09-24); both are on here, as
// in the live app. Each story is one state the page reaches from its reads.

const LIVE_FLAGS = [
  AGENTS_NAV_FEATURE_FLAG_KEY,
  AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY,
];

function withRoutes(overrides: FixtureRoute[]): FixtureRoute[] {
  return [...overrides, ...agentsApiRoutes];
}

/** A term no fixture name contains, so the search narrows to nothing. */
const NO_MATCH_TERM = "zzz-nothing-matches";

/** The Agents sidebar item; its accessible name also carries the count badge. */
const AGENTS_NAV_LINK = /^Agents/;

const meta = {
  title: "Surfaces/Labs/Agents/Agents List",
  tags: ["preview"],
  render: () => (
    <LivePage activePath="/agents">
      <AgentsPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: agentsApiRoutes, enabledFlags: LIVE_FLAGS },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1 })
    ).toBeInTheDocument();
    await expect(
      await canvas.findByText(agentComponentsFixture[0]?.name ?? "")
    ).toBeVisible();
    await expect(
      await canvas.findByRole("link", { name: AGENTS_NAV_LINK })
    ).toHaveAttribute("data-active", "true");
  },
};

/** The inventory read is still in flight. */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        {
          method: "GET",
          path: "/agent-components",
          respond: () => new Promise(() => undefined),
        },
      ]),
      enabledFlags: LIVE_FLAGS,
    },
  },
};

/** A workspace with no agent components recorded yet. */
export const Empty: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([agentsListRoute([])]),
      enabledFlags: LIVE_FLAGS,
    },
  },
};

/** A search that matches nothing. */
export const NoMatches: Story = {
  play: async ({ canvasElement }) => {
    const main = within(await within(canvasElement).findByRole("main"));
    await userEvent.type(await main.findByRole("searchbox"), NO_MATCH_TERM);
  },
};

/** The inventory read failed. */
export const ErrorState: Story = {
  name: "Error",
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        {
          method: "GET",
          path: "/agent-components",
          respond: () => null,
          status: 500,
        },
      ]),
      enabledFlags: LIVE_FLAGS,
    },
  },
};

/** The Plugins tab of a workspace with no plugins installed. */
export const PluginsInventoryEmpty: Story = {
  parameters: {
    appCore: {
      apiRoutes: withRoutes([
        agentsListRoute(
          agentComponentsFixture.filter(
            (item) => item.kind !== AgentComponentKind.Plugin
          )
        ),
      ]),
      enabledFlags: LIVE_FLAGS,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByLabelText(KIND_META[AgentComponentKind.Plugin].plural)
    );
  },
};

/** `agents-surface-honesty` on: the KPI strip pinned above the scroll plane. */
export const MetricsPinned: Story = {
  parameters: {
    appCore: {
      apiRoutes: agentsApiRoutes,
      enabledFlags: [...LIVE_FLAGS, AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY],
    },
  },
};

/**
 * `MetricsPinned` at phone width (ISS-9282): the strip is one rank that scrolls
 * sideways in its own band, so the rows below keep the column. It used to pair
 * the cards two-up, and two ranks of cards pinned above the rows took the
 * height the rows needed.
 */
export const MetricsPinnedNarrow: Story = {
  ...MetricsPinned,
  globals: { viewport: { value: "390-844" } },
};
