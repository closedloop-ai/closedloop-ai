import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useState } from "react";
import type { AgentSessionsDataSource } from "../data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "../data-source/provider";
import { agentsLastVisitedKey } from "../lib/agents-activity-storage-key";
import { AgentsNavBadge } from "./agents-nav-badge";

/**
 * ISS-9398: the sidebar activity badge, mounted on every page load of both
 * shells — not a component that only renders when someone opens Agents.
 *
 * It reads two things the story has to drive independently: the finished-count
 * query (`useAgentSessions`, injected via {@link AgentSessionsDataSourceProvider}
 * the way the hook's own unit test does), and the per-org "last visited" marker
 * in `localStorage` that gates the query at all (`useAgentsNavActivity`'s
 * `enabled`). Without a marker the badge always renders nothing — a real
 * first-time-user state, and why every count story here seeds one.
 *
 * The static auth adapter `AppCoreStoryProviders` mounts globally
 * (`.storybook/preview.tsx`) resolves `orgId: "org_test"`, so the marker key
 * below is the same one `agents-nav-badge.test.tsx` seeds.
 */

const ORG_ID = "org_test";
const LAST_VISITED_KEY = agentsLastVisitedKey(ORG_ID);
/** Well before "now", so `completedAfter` always has a real window to count. */
const LAST_VISITED_AT = "2026-05-01T00:00:00.000Z";

function sessionCountSource(total: number): AgentSessionsDataSource {
  return {
    scope: "storybook-nav-badge",
    list: () =>
      Promise.resolve({
        items: [],
        total,
        viewerScope: AgentSessionViewerScope.Organization,
      } satisfies AgentSessionListResponse),
    detail: () => Promise.reject(new Error("detail unused in this story")),
    usage: () => Promise.reject(new Error("usage unused in this story")),
    analytics: () =>
      Promise.reject(new Error("analytics unused in this story")),
    pageData: () => Promise.reject(new Error("pageData unused in this story")),
  };
}

/** A count read that never settles, for the Loading state. */
const PENDING_SOURCE: AgentSessionsDataSource = {
  scope: "storybook-nav-badge-pending",
  list: () => new Promise<never>(() => undefined),
  detail: () => Promise.reject(new Error("detail unused in this story")),
  usage: () => Promise.reject(new Error("usage unused in this story")),
  analytics: () => Promise.reject(new Error("analytics unused in this story")),
  pageData: () => Promise.reject(new Error("pageData unused in this story")),
};

/**
 * Seeds the per-org "last visited" marker synchronously — a lazy `useState`
 * initializer, not an effect, so `useAgentsNavActivity`'s
 * `useSyncExternalStore` read already sees it on the FIRST render. An effect
 * would run one render too late: the query would mount disabled (no marker
 * yet), and the badge would flash its no-marker "renders nothing" state before
 * ever asking.
 *
 * `null` clears the marker instead, for the stories that need the genuine
 * first-visit case.
 */
function VisitMarkerSeed({
  children,
  lastVisitedAt,
}: Readonly<{ children: ReactNode; lastVisitedAt: string | null }>) {
  useState(() => {
    try {
      if (lastVisitedAt === null) {
        window.localStorage.removeItem(LAST_VISITED_KEY);
      } else {
        window.localStorage.setItem(
          LAST_VISITED_KEY,
          JSON.stringify(lastVisitedAt)
        );
      }
    } catch {
      // Storage blocked (private window, locked-down preview iframe): the
      // badge falls through to its own honest no-marker state.
    }
    return null;
  });
  return <>{children}</>;
}

function navBadgeDecorator(
  dataSource: AgentSessionsDataSource,
  lastVisitedAt: string | null = LAST_VISITED_AT
): Decorator {
  return (Story) => (
    <VisitMarkerSeed lastVisitedAt={lastVisitedAt}>
      <AgentSessionsDataSourceProvider dataSource={dataSource}>
        <div className="flex w-56 items-center justify-between rounded-md border bg-sidebar p-2 text-sidebar-foreground text-sm">
          <span>Agents</span>
          <Story />
        </div>
      </AgentSessionsDataSourceProvider>
    </VisitMarkerSeed>
  );
}

const meta = {
  title: "Composites v1.0/Agents/General/Agents Nav Badge",
  component: AgentsNavBadge,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: { isActive: false },
} satisfies Meta<typeof AgentsNavBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A handful of sessions finished since the last visit — the plain count pill. */
export const BelowCap: Story = {
  decorators: [navBadgeDecorator(sessionCountSource(3))],
};

/**
 * More finished sessions than `AGENTS_NAV_BADGE_MAX` (9) can show. The pill
 * caps its visible digits at `9+`; the accessible name still announces the
 * true count.
 */
export const AtCapOverflow: Story = {
  decorators: [navBadgeDecorator(sessionCountSource(24))],
};

/**
 * Settled at zero. A zero count is not "no badge because we haven't asked" —
 * it is a real read that found nothing — and it renders exactly like the
 * loading and first-visit states: nothing at all.
 */
export const Zero: Story = {
  decorators: [navBadgeDecorator(sessionCountSource(0))],
};

/** The count read is still in flight. Renders nothing, same as {@link Zero}. */
export const Loading: Story = {
  decorators: [navBadgeDecorator(PENDING_SOURCE)],
};

/**
 * Agents is the open route. The badge is hidden and the visit marker is being
 * drained (`markVisited`), regardless of how many sessions the source reports.
 */
export const ActiveRoute: Story = {
  args: { isActive: true },
  decorators: [navBadgeDecorator(sessionCountSource(3))],
};
