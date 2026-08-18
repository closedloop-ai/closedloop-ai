import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsNavBadge } from "../agents-nav-badge";

// The hook reads its org scope from the injected auth port, not a prop.
// `AppCoreStoryProviders` mounts the static auth adapter, whose orgId is
// `org_test`, so the per-org marker key is scoped to that org here.
const ORG_ID = "org_test";
const LAST_VISITED_KEY = `closedloop.app.agents.lastVisitedAt.${ORG_ID}`;

describe("AgentsNavBadge", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders nothing and never fetches before the first visit is recorded", async () => {
    const source = createSource(5);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createWrapper(source),
    });

    // No last-visited marker → the count query is disabled, so no request is
    // made and no badge is shown.
    await waitFor(() => expect(source.list).not.toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the finished-since-last-visit count with an accessible name", async () => {
    localStorage.setItem(
      LAST_VISITED_KEY,
      JSON.stringify("2026-07-01T00:00:00.000Z")
    );
    const source = createSource(3);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createWrapper(source),
    });

    const badge = await screen.findByRole("status");
    expect(badge).toHaveTextContent("3");
    expect(badge).toHaveAccessibleName("3 recently finished sessions");

    // ISS-4586: queries finished-not-failed sessions, bounded by the stored
    // last-visited time. The status is the canonical lowercase wire value the
    // Sessions filter and both query builders speak (`"inactive"`), not the
    // projected UI state — the latter matches nothing on web. Reaped orphans are
    // stamped `inactive`, and both surfaces expand a requested `inactive` facet
    // to also match legacy `completed`/`abandoned`, so no finished session is
    // dropped.
    //
    // FEA-3009: the boundary must be sent as `completedAfter` (filters on the
    // terminal completion timestamp on BOTH surfaces), NOT `startDate` — which
    // the list route applies to `lastActivityAt` (cloud) / `startedAt`
    // (desktop) and so counted long-running sessions inconsistently.
    const listCall = vi.mocked(source.list).mock.calls[0]?.[0];
    expect(listCall).toEqual(
      expect.objectContaining({
        statuses: [SESSION_STATUS.INACTIVE],
        completedAfter: "2026-07-01T00:00:00.000Z",
        // FEA-4142: the badge reads only `total`, so it MUST mark the read
        // count-only. Pin it here — without the hint the desktop poll falls back
        // to full-corpus hydration every 5 minutes (the FEA-2038 db-host OOM).
        countOnly: true,
      })
    );
    // The old startDate boundary is no longer sent (it was not a completion
    // boundary and diverged across surfaces).
    expect(listCall?.startDate).toBeUndefined();
  });

  it("renders a capped 9+ display for large counts while announcing the true count", async () => {
    localStorage.setItem(
      LAST_VISITED_KEY,
      JSON.stringify("2026-07-01T00:00:00.000Z")
    );
    const source = createSource(412);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createWrapper(source),
    });

    const badge = await screen.findByRole("status");
    // The pill shows a truthful "9+" rather than the raw 412 or a misleading 99…
    expect(badge).toHaveTextContent("9+");
    // …but the accessible name still announces the real count.
    expect(badge).toHaveAccessibleName("412 recently finished sessions");
  });

  it("hides the badge and stamps the visit when Agents is the active route", async () => {
    localStorage.setItem(
      LAST_VISITED_KEY,
      JSON.stringify("2026-07-01T00:00:00.000Z")
    );
    const source = createSource(3);

    render(<AgentsNavBadge isActive />, {
      wrapper: createWrapper(source),
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // Opening Agents advances the last-visited marker so the badge drains.
    await waitFor(() => {
      const stored = localStorage.getItem(LAST_VISITED_KEY);
      expect(stored).not.toBe(JSON.stringify("2026-07-01T00:00:00.000Z"));
      expect(stored).not.toBeNull();
    });
  });
});

function createSource(total: number): AgentSessionsDataSource {
  return {
    scope: "source",
    list: vi.fn().mockResolvedValue({
      items: [],
      total,
      viewerScope: AgentSessionViewerScope.Organization,
    } satisfies AgentSessionListResponse),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage: vi.fn().mockRejectedValue(new Error("usage unused")),
    analytics: vi.fn().mockRejectedValue(new Error("analytics unused")),
    pageData: vi.fn().mockRejectedValue(new Error("pageData unused")),
  };
}

function createWrapper(source: AgentSessionsDataSource) {
  return ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders>
      <AgentSessionsDataSourceProvider dataSource={source}>
        {children}
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}
