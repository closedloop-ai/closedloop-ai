/**
 * `components/__tests__/agents-nav-badge.test.tsx` owns the plural name, the `9+`
 * cap, and the visit stamp as the badge renders them — not restated here.
 *
 * It also owns the filter shape for a WELL-FORMED marker. This file owns the filter
 * shape for a MALFORMED one (ISS-8533), because that is a property of this hook's own
 * coercion rather than of the badge: the marker is what bounds the query, so a marker
 * that cannot bound it must read as absent instead of widening the population.
 *
 * The first two blocks drive the hook through `AgentsNavBadge`, its legacy consumer,
 * so what is pinned there is the rendered outcome. The last block reads the hook's own
 * return, because the v2 sidebar consumes the count directly: there an in-flight read
 * must be `pending` and a failed one `unavailable`, never the zero the hook used to
 * report for both.
 */

import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { NavigationCountStatus } from "@repo/api/src/types/navigation-view-model";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsNavBadge } from "../../components/agents-nav-badge";
import { agentsLastVisitedKey } from "../../lib/agents-activity-storage-key";
import { useAgentsNavActivity } from "../use-agents-nav-activity";

describe("useAgentsNavActivity — a failed read is not a count", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LAST_VISITED_KEY, JSON.stringify(LAST_VISITED_AT));
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("announces a single finished session in the singular", async () => {
    // Control for the rejection case below, and `count === 1` is the one label
    // branch neither suite covered — a badge reading "1 ... sessions".
    const source = createRespondingSource(1);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createDataSourceWrapper(source),
    });

    const badge = await screen.findByRole("status");
    expect(badge).toHaveAccessibleName("1 recently finished session");
  });

  it("renders no count at all when the read is rejected", async () => {
    const source = createRejectingSource();

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createDataSourceWrapper(source),
    });

    // A FAILED fetch, not a disabled query. The paired success case above is
    // what makes the absences below meaningful: a harness rendering nothing at
    // all would satisfy them on its own.
    await waitFor(() => expect(source.list).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(FINISHED_SESSIONS_TEXT)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(FINISHED_SESSIONS_TEXT)
    ).not.toBeInTheDocument();
  });

  it("skips the poll entirely while Agents is the active route (FEA-4142)", async () => {
    const source = createRespondingSource(3);

    render(<AgentsNavBadge isActive />, {
      wrapper: createDataSourceWrapper(source),
    });

    // The stamp proves the component mounted and its effect ran. On desktop
    // this query's filters disable both SQL fast paths, so an un-skipped poll
    // is the FEA-2038 full-corpus hydration every five minutes.
    await waitFor(() => {
      expect(localStorage.getItem(LAST_VISITED_KEY)).not.toBe(
        JSON.stringify(LAST_VISITED_AT)
      );
    });
    expect(source.list).not.toHaveBeenCalled();
  });
});

/**
 * ISS-8533: a marker that cannot bound the query must behave like an ABSENT one.
 *
 * `markVisited` always writes `toISOString()`, so a non-usable marker needs version
 * skew, a foreign writer, or a hand-edited key. The failure is silent and the two
 * surfaces disagree: `Boolean(<number>)` is truthy so the `enabled` gate opens, then
 * desktop drops the non-string bound and answers COUNT(*) over its entire inactive
 * corpus behind the word "recently", while web interpolates it and 400s.
 *
 * Seeds are the EXACT bytes localStorage holds. `1756598400000` is the number; the
 * quoted `"banana"` is a JSON string that reaches the coercion; the unquoted `banana`
 * is a parse ERROR that never gets there, and is kept as the control that tells the
 * two apart.
 */
describe("useAgentsNavActivity — an unusable marker is an absent marker", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("CONTROL: a valid ISO marker fetches and shows the badge", async () => {
    // The positive control every absence assertion below leans on. Without it a
    // harness that rendered nothing at all would satisfy them.
    localStorage.setItem(LAST_VISITED_KEY, JSON.stringify(LAST_VISITED_AT));
    const source = createRespondingSource(2);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createDataSourceWrapper(source),
    });

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(vi.mocked(source.list).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ completedAfter: LAST_VISITED_AT })
    );
  });

  it("RED: a bare epoch NUMBER never reaches the query", async () => {
    localStorage.setItem(LAST_VISITED_KEY, "1756598400000");
    const source = createRespondingSource(7);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createDataSourceWrapper(source),
    });

    // Today the gate opens and `completedAfter` goes out as a NUMBER — dropped by
    // the desktop source, so the badge would render 7 as "recently finished".
    await waitFor(() => expect(source.list).not.toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("RED: a STRING that parses to no instant never reaches the query", async () => {
    // A `typeof === "string"` check alone passes the case above and fails this one,
    // which is exactly why both exist: `Date.parse("banana")` is NaN, so this marker
    // cannot bound anything either.
    localStorage.setItem(LAST_VISITED_KEY, JSON.stringify("banana"));
    const source = createRespondingSource(7);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createDataSourceWrapper(source),
    });

    await waitFor(() => expect(source.list).not.toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("RED: a DATE-ONLY string never reaches the query", async () => {
    // `Date.parse("2026-01-01")` is finite, so a parses-to-an-instant check alone
    // passes this and ships an arbitrary UTC-midnight bound to both surfaces — old
    // sessions counted as recent rather than the marker being dropped. This key is
    // only ever written as a full `toISOString()`, so nothing valid is lost.
    localStorage.setItem(LAST_VISITED_KEY, JSON.stringify("2026-01-01"));
    const source = createRespondingSource(7);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createDataSourceWrapper(source),
    });

    await waitFor(() => expect(source.list).not.toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("PIN(cf): unparseable BYTES were already absent, via a different path", async () => {
    // Distinguishes the two "banana"s. This one throws in `JSON.parse` and takes the
    // pre-existing catch, so it never reaches the coercion at all.
    localStorage.setItem(LAST_VISITED_KEY, "banana");
    const source = createRespondingSource(7);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createDataSourceWrapper(source),
    });

    await waitFor(() => expect(source.list).not.toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("PIN: an absent marker still disables the query", async () => {
    const source = createRespondingSource(7);

    render(<AgentsNavBadge isActive={false} />, {
      wrapper: createDataSourceWrapper(source),
    });

    await waitFor(() => expect(source.list).not.toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("useAgentsNavActivity — the count says which read it came from", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LAST_VISITED_KEY, JSON.stringify(LAST_VISITED_AT));
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reports no count before the first visit is recorded", async () => {
    localStorage.clear();
    const source = createRespondingSource(3);

    const { result } = renderHook(
      () => useAgentsNavActivity({ isActive: false }),
      { wrapper: createDataSourceWrapper(source) }
    );

    await waitFor(() => expect(source.list).not.toHaveBeenCalled());
    expect(result.current.count).toBeUndefined();
  });

  it("reports no count while Agents is the open route", () => {
    const source = createRespondingSource(3);

    const { result } = renderHook(
      () => useAgentsNavActivity({ isActive: true }),
      { wrapper: createDataSourceWrapper(source) }
    );

    expect(result.current.count).toBeUndefined();
  });

  it("fires no count query for a row the host is not offering", async () => {
    const source = createRespondingSource(3);

    const { rerender, result } = renderHook(
      ({ offered }: { offered: boolean }) =>
        useAgentsNavActivity({ isActive: false, offered }),
      {
        initialProps: { offered: false },
        wrapper: createDataSourceWrapper(source),
      }
    );

    await waitFor(() => expect(source.list).not.toHaveBeenCalled());
    expect(result.current.count).toBeUndefined();

    // Same marker, same source, same route: offering the row is the only thing
    // that changed, so the absence above is about `offered` rather than about a
    // harness that could never have fetched at all.
    rerender({ offered: true });
    await waitFor(() => expect(source.list).toHaveBeenCalled());
  });

  it("reports a pending count while the read is in flight", () => {
    const source = createPendingSource();

    const { result } = renderHook(
      () => useAgentsNavActivity({ isActive: false }),
      { wrapper: createDataSourceWrapper(source) }
    );

    expect(result.current.count).toEqual({
      status: NavigationCountStatus.Pending,
    });
  });

  it("reports an unavailable count, not a zero, when the read fails", async () => {
    const source = createRejectingSource();

    const { result } = renderHook(
      () => useAgentsNavActivity({ isActive: false }),
      { wrapper: createDataSourceWrapper(source) }
    );

    await waitFor(() =>
      expect(result.current.count).toEqual({
        status: NavigationCountStatus.Unavailable,
      })
    );
  });

  it("stamps the visit once when Agents becomes the open route", async () => {
    const source = createRespondingSource(3);
    // Every write to the marker announces itself as a `storage` event, so the
    // events are the stamps.
    const stamps: string[] = [];
    const recordStamp = (event: Event) => {
      if (event instanceof StorageEvent && event.key === LAST_VISITED_KEY) {
        stamps.push(String(event.newValue));
      }
    };
    globalThis.addEventListener("storage", recordStamp);

    try {
      const { rerender } = renderHook(
        ({ isActive }: { isActive: boolean }) =>
          useAgentsNavActivity({ isActive }),
        {
          initialProps: { isActive: false },
          wrapper: createDataSourceWrapper(source),
        }
      );
      expect(stamps).toHaveLength(0);

      rerender({ isActive: true });
      rerender({ isActive: true });

      await waitFor(() => expect(stamps).toHaveLength(1));
    } finally {
      globalThis.removeEventListener("storage", recordStamp);
    }
  });
});

function createRespondingSource(total: number): AgentSessionsDataSource {
  return {
    ...baseSource(),
    list: vi.fn().mockResolvedValue({
      items: [],
      total,
      viewerScope: AgentSessionViewerScope.Organization,
    } satisfies AgentSessionListResponse),
  };
}

function createRejectingSource(): AgentSessionsDataSource {
  return {
    ...baseSource(),
    // The shape a 401/403 takes by the time it reaches the query.
    list: vi.fn().mockRejectedValue(new Error("401 Unauthorized")),
  };
}

function createPendingSource(): AgentSessionsDataSource {
  return {
    ...baseSource(),
    list: vi.fn().mockReturnValue(new Promise(() => undefined)),
  };
}

function baseSource(): AgentSessionsDataSource {
  return {
    scope: "source",
    list: vi.fn().mockRejectedValue(new Error("list unused")),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage: vi.fn().mockRejectedValue(new Error("usage unused")),
    analytics: vi.fn().mockRejectedValue(new Error("analytics unused")),
    pageData: vi.fn().mockRejectedValue(new Error("pageData unused")),
  };
}

function createDataSourceWrapper(source: AgentSessionsDataSource) {
  return ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders>
      <AgentSessionsDataSourceProvider dataSource={source}>
        {children}
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

// `AppCoreStoryProviders` mounts the static auth adapter, whose orgId is
// `org_test`; the hook scopes its marker key per org off that injected port.
const ORG_ID = "org_test";
const LAST_VISITED_KEY = agentsLastVisitedKey(ORG_ID);
const LAST_VISITED_AT = "2026-07-01T00:00:00.000Z";
const FINISHED_SESSIONS_TEXT = /recently finished/i;
