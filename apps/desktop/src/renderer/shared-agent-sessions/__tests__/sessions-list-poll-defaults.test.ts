import { agentSessionKeys } from "@repo/app/agents/hooks/use-agent-sessions";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  applyDesktopSessionsListPollDefaults,
  DESKTOP_SESSIONS_DETAIL_REFETCH_INTERVAL_MS,
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
function resolveInterval(interval: unknown): unknown {
  return typeof interval === "function"
    ? (interval as (query: unknown) => unknown)(undefined)
    : interval;
}

describe("applyDesktopSessionsListPollDefaults", () => {
  it("sets a background poll default on the sessions list key", () => {
    const client = new QueryClient();
    applyDesktopSessionsListPollDefaults(client);

    const listDefaults = client.getQueryDefaults(
      agentSessionKeys.list("local", {})
    );
    // Service-aware: a FUNCTION, which with no observed read yet resolves to the
    // floor — byte-identical to the fixed cadence it replaced.
    expect(resolveInterval(listDefaults.refetchInterval)).toBe(
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
    const pageDataDefaults = client.getQueryDefaults(
      agentSessionKeys.pageData("local", {})
    );
    expect(resolveInterval(pageDataDefaults.refetchInterval)).toBe(
      DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS
    );
    expect(pageDataDefaults.refetchIntervalInBackground).toBe(true);
  });

  it("sets a background poll default on the sessions detail key (FEA-3481 G4)", () => {
    const client = new QueryClient();
    applyDesktopSessionsListPollDefaults(client);

    const detailDefaults = client.getQueryDefaults(
      agentSessionKeys.detail("local", "session-1")
    );
    expect(detailDefaults.refetchInterval).toBe(
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
});
