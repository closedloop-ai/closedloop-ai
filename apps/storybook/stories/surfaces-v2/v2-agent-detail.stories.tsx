import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import {
  AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY,
  AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY,
  AGENTS_NAV_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { AgentDetailHeader } from "@/app/(authenticated)/[orgSlug]/agents/[slug]/agent-detail-header";
import { AgentDetailWithPromote } from "@/app/(authenticated)/[orgSlug]/agents/[slug]/agent-detail-with-promote";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";
import {
  agentDetailFixture,
  agentDetailRoutes,
  agentsApiRoutes,
} from "./fixtures/agents-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar, entry 12 of 62: Agent Detail (Record detail).
// `apps/app/.../agents/[slug]/page.tsx` is an async server component, so this
// renders the tree it returns: the `agentsNav` route gate, `AgentDetailHeader`
// and `AgentDetailWithPromote` for the `subagent::code-reviewer` route, in the
// app frame. Each story is one state the live page reaches from its reads.

const ORG_SLUG = "org-test";
const LIVE_FLAGS = [
  AGENTS_NAV_FEATURE_FLAG_KEY,
  AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY,
];

function detailRoutes(detail: AgentComponentDetail): FixtureRoute[] {
  return [...agentDetailRoutes(detail), ...agentsApiRoutes];
}

function withDetail(
  overrides: Partial<AgentComponentDetail>,
  flags: readonly string[] = LIVE_FLAGS
) {
  return {
    appCore: {
      apiRoutes: detailRoutes({ ...agentDetailFixture, ...overrides }),
      enabledFlags: flags,
    },
  };
}

const EMPTY_STATE_FLAGS = [
  ...LIVE_FLAGS,
  AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY,
];

/** The Agents sidebar item; its accessible name also carries the count badge. */
const AGENTS_NAV_LINK = /^Agents/;

const meta = {
  title: "Surfaces/Labs/Agents/Agent Detail",
  tags: ["preview"],
  render: () => (
    <LivePage activePath="/agents">
      <FeatureFlagRouteGate
        flag={AGENTS_NAV_FEATURE_FLAG_KEY}
        pending={
          <RouteChromeFallback
            breadcrumbs={[{ href: `/${ORG_SLUG}/agents`, label: "Agents" }]}
          />
        }
      >
        <AgentDetailHeader orgSlug={ORG_SLUG} slug={agentDetailFixture.slug} />
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
          <AgentDetailWithPromote
            orgSlug={ORG_SLUG}
            slug={agentDetailFixture.slug}
          />
        </div>
      </FeatureFlagRouteGate>
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: {
      apiRoutes: detailRoutes(agentDetailFixture),
      enabledFlags: LIVE_FLAGS,
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: agentDetailFixture.name })
    ).toBeVisible();
    // The breadcrumb also links to Agents; the sidebar item is the active one.
    const links = await canvas.findAllByRole("link", { name: AGENTS_NAV_LINK });
    await expect(
      links.some((link) => link.getAttribute("data-active") === "true")
    ).toBe(true);
  },
};

/** The detail read is still in flight. */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: "/agent-components/*",
          respond: () => new Promise(() => undefined),
        },
        ...agentsApiRoutes,
      ],
      enabledFlags: LIVE_FLAGS,
    },
  },
};

/** No component answers to this route's slug. */
export const NotFound: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: "/agent-components/*",
          respond: () => null,
          status: 404,
        },
        ...agentsApiRoutes,
      ],
      enabledFlags: LIVE_FLAGS,
    },
  },
};

/** A definition is on record but nothing readable arrived. */
export const Unavailable: Story = {
  parameters: withDetail(
    {
      prompt: null,
      resolvedState: ComponentResolvedState.Inaccessible,
      versions: [],
    },
    EMPTY_STATE_FLAGS
  ),
};

/** History truncated with more than one revision kept: the selector draws. */
export const TruncatedWithSelector: Story = {
  parameters: withDetail({ versionsTruncated: true }),
};

/** History truncated to one retained revision: no selector. */
export const TruncatedSingleRevision: Story = {
  parameters: withDetail({
    versions: agentDetailFixture.versions.slice(0, 1),
    versionsTruncated: true,
  }),
};

/** A skill whose definition was never recorded. */
export const DefinitionNeverRecorded: Story = {
  parameters: withDetail(
    {
      kind: AgentComponentKind.Skill,
      prompt: null,
      resolvedState: ComponentResolvedState.Unresolved,
      versions: [],
    },
    EMPTY_STATE_FLAGS
  ),
};

/** A correctly captured, empty definition. */
export const DefinitionCapturedEmpty: Story = {
  parameters: withDetail(
    {
      prompt: null,
      resolvedState: ComponentResolvedState.Resolved,
      versions: agentDetailFixture.versions
        .slice(0, 1)
        .map((version) => ({ ...version, content: "" })),
    },
    EMPTY_STATE_FLAGS
  ),
};

/** The never-recorded definition with `agents-definition-empty-state` off. */
export const DefinitionAbsenceFlagOff: Story = {
  parameters: withDetail({
    kind: AgentComponentKind.Skill,
    prompt: null,
    resolvedState: ComponentResolvedState.Unresolved,
    versions: [],
  }),
};
