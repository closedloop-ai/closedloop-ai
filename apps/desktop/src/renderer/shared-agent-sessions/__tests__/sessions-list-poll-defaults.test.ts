import {
  agentSessionKeys,
  SESSIONS_OUTSIDE_WINDOW_PROBE_FILTERS,
} from "@repo/app/agents/hooks/agent-session-keys";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDesktopSessionsListPollDefaults,
  DESKTOP_SESSIONS_DETAIL_REFETCH_INTERVAL_MS,
  DESKTOP_SESSIONS_HIDDEN_REFETCH_INTERVAL_MS,
  DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS,
} from "../sessions-list-poll-defaults";

/**
 * FEA-2187 / FEA-3481: the desktop Sessions LIST and open DETAIL queries poll as
 * a fallback because their push refresh (the shared live bridge) is
 * visibility-gated and can defer a post-import flush forever when the renderer
 * reports `document.hidden` (CI/offscreen Electron). These assertions pin the
 * load-bearing parts: both polls run in the background
 * (`refetchIntervalInBackground`) — without that, React Query pauses the poll in
 * exactly the hidden state we must cover — the LIST key uses the fast cadence and
 * the DETAIL key the slower one, and usage/analytics stay pure-push.
 */
/**
 * The list/page-data interval is service-aware, so it is a function rather than
 * a number. Resolve it the way React Query does — call it with the query — so
 * these assertions read the value the scheduler would actually use.
 */
function resolveInterval(interval: unknown, queryKey: QueryKey): unknown {
  return typeof interval === "function"
    ? (interval as (query: { queryKey: QueryKey }) => unknown)({ queryKey })
    : interval;
}

describe("applyDesktopSessionsListPollDefaults", () => {
  it("sets a background poll default on the sessions list key", () => {
    const client = new QueryClient();
    applyDesktopSessionsListPollDefaults(client);

    const listKey = agentSessionKeys.list("local", {});
    const listDefaults = client.getQueryDefaults(listKey);
    // Service-aware: a FUNCTION, which with no observed read yet resolves to the
    // floor — byte-identical to the fixed cadence it replaced.
    expect(resolveInterval(listDefaults.refetchInterval, listKey)).toBe(
      DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS
    );
    // Load-bearing: must keep polling while the window is hidden.
    expect(listDefaults.refetchIntervalInBackground).toBe(true);
    // ISS-4772: the refetch-on-mount guarantee is scoped to the detail key only —
    // the list already self-heals via its background poll + keep-previous data.
    expect(listDefaults.refetchOnMount).toBeUndefined();
  });

  it("sets the list-cadence background poll default on the combined page-data key (FEA-4157)", () => {
    const client = new QueryClient();
    applyDesktopSessionsListPollDefaults(client);

    // The org Sessions view reads its list + summary through `pageData`, so its
    // key must carry the same fast list-cadence fallback or a hidden renderer's
    // table + cards would stay stuck on the initial empty fetch.
    const pageDataKey = agentSessionKeys.pageData("local", {});
    const pageDataDefaults = client.getQueryDefaults(pageDataKey);
    expect(resolveInterval(pageDataDefaults.refetchInterval, pageDataKey)).toBe(
      DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS
    );
    expect(pageDataDefaults.refetchIntervalInBackground).toBe(true);
  });

  it("sets a background poll default on the sessions detail key (FEA-3481 G4)", () => {
    const client = new QueryClient();
    applyDesktopSessionsListPollDefaults(client);

    const detailKey = agentSessionKeys.detail("local", "session-1");
    const detailDefaults = client.getQueryDefaults(detailKey);
    expect(resolveInterval(detailDefaults.refetchInterval, detailKey)).toBe(
      DESKTOP_SESSIONS_DETAIL_REFETCH_INTERVAL_MS
    );
    // Load-bearing: an open detail on a permanently-hidden renderer never fires
    // `visibilitychange`, so the poll must keep running while hidden.
    expect(detailDefaults.refetchIntervalInBackground).toBe(true);
    // ISS-4772: a freshly-mounted detail must force a read even under
    // staleTime:Infinity, so a cache entry that predates a detached push cannot
    // render empty forever. Only the detail key carries this.
    expect(detailDefaults.refetchOnMount).toBe("always");
  });

  it("does not poll usage/analytics session queries (they stay pure-push)", () => {
    const client = new QueryClient();
    applyDesktopSessionsListPollDefaults(client);

    const usageDefaults = client.getQueryDefaults(
      agentSessionKeys.usage("local", {})
    );
    expect(usageDefaults.refetchInterval).toBeUndefined();
    expect(usageDefaults.refetchIntervalInBackground).toBeUndefined();

    const analyticsDefaults = client.getQueryDefaults(
      agentSessionKeys.analytics("local", {})
    );
    expect(analyticsDefaults.refetchInterval).toBeUndefined();
    expect(analyticsDefaults.refetchIntervalInBackground).toBeUndefined();
  });

  it("polls the outside-window probe on the slow clock while visible (ISS-11913)", () => {
    const client = new QueryClient();
    applyDesktopSessionsListPollDefaults(client);

    const probeKey = agentSessionKeys.list(
      "local",
      SESSIONS_OUTSIDE_WINDOW_PROBE_FILTERS
    );
    const probeDefaults = client.getQueryDefaults(probeKey);
    expect(resolveInterval(probeDefaults.refetchInterval, probeKey)).toBe(
      DESKTOP_SESSIONS_HIDDEN_REFETCH_INTERVAL_MS
    );
    expect(probeDefaults.refetchIntervalInBackground).toBe(true);
  });

  describe("the list service-time estimate (ISS-11913)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ["a list read raises", {}, SLOW_READ_MS],
      [
        "the outside-window probe leaves",
        SESSIONS_OUTSIDE_WINDOW_PROBE_FILTERS,
        DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS,
      ],
    ])("%s the list cadence", async (_case, filters, expected) => {
      vi.useFakeTimers();
      const client = new QueryClient();
      applyDesktopSessionsListPollDefaults(client);

      const read = client.fetchQuery({
        queryFn: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({}), SLOW_READ_MS);
          }),
        queryKey: agentSessionKeys.list("local", filters),
      });
      await vi.advanceTimersByTimeAsync(SLOW_READ_MS);
      await read;

      const listKey = agentSessionKeys.list("local", {});
      expect(
        resolveInterval(
          client.getQueryDefaults(listKey).refetchInterval,
          listKey
        )
      ).toBe(expected);
    });
  });

  describe("while the renderer is hidden", () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");

    afterEach(() => {
      if (originalHidden) {
        Object.defineProperty(document, "hidden", originalHidden);
      } else {
        Reflect.deleteProperty(document, "hidden");
      }
    });

    it("drops the list, page-data and detail polls to the slow hidden cadence (operator ruling 2026-10-05)", () => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      const client = new QueryClient();
      applyDesktopSessionsListPollDefaults(client);

      for (const key of [
        agentSessionKeys.list("local", {}),
        agentSessionKeys.pageData("local", {}),
        agentSessionKeys.detail("local", "session-1"),
      ]) {
        const defaults = client.getQueryDefaults(key);
        expect(resolveInterval(defaults.refetchInterval, key)).toBe(
          DESKTOP_SESSIONS_HIDDEN_REFETCH_INTERVAL_MS
        );
        // Still polling while hidden, so a permanently-hidden renderer heals.
        expect(defaults.refetchIntervalInBackground).toBe(true);
        // Re-show refetches, which re-arms the visible cadence.
        expect(defaults.refetchOnWindowFocus).toBe("always");
      }
    });
  });
});

/** Between the list floor and ceiling, so a tracked read moves the cadence. */
const SLOW_READ_MS = 10_000;
