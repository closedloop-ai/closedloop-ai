import {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { drainedCutover } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";

/**
 * PLN-1138 Phase 2 regression guard (raised in review): in cloud mode the
 * Sessions view reads the HTTP source over the D-G bridge, so the read gate must
 * NOT depend on local-monitor readiness. This mounts SessionsView in cloud mode
 * with the local monitor *unavailable* and asserts the sessions query is still
 * enabled and the list still renders (`displayState` collapses to "ready") —
 * i.e. an authenticated+online user sees cloud rows even when the local monitor
 * is down. `sessions-view-responsive.test.tsx` covers the default Local path.
 */

const hooks = vi.hoisted(() => ({
  useAgentSessionAnalytics: vi.fn(),
  useAgentSessionsPageData: vi.fn(),
  useAgentSessionUsage: vi.fn(),
  useLocalAgentSessionUsage: vi.fn(),
  useIngestProgress: vi.fn(),
  useSessionsViewState: vi.fn(),
  useSharedDateRange: vi.fn(),
  useSearchParamsValue: vi.fn(),
}));

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
}));

let desktopApiDescriptor: PropertyDescriptor | undefined;

vi.mock("@repo/app/agents/components/sessions/agent-sessions-list", () => ({
  AgentSessionsListContent: () => <div data-testid="sessions-table-body" />,
}));

vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: () => <div data-testid="sessions-toolbar" />,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
}));

// FEA-3574 review (wongk): in Cloud mode SessionsView reads the LOCAL usage
// totals via this hook (a real `useQuery`) so the always-available cards stay
// SQLite-backed. Stub it so this cloud-read-gate test doesn't need a
// `QueryClientProvider`; the local-source data flow is asserted in the shared
// sessions-summary-cards tests.
vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: hooks.useLocalAgentSessionUsage,
}));

// FEA-4128: SessionsView polls the shared ingest progress in Cloud mode to hold
// the always-available cards in a skeleton while a first-launch import is still
// populating the local store. Stub the hook (and re-export its type) so these
// tests drive the import-in-progress signal directly.
vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
  // FEA-3639: SessionsView renders the file-access banner, which reads this
  // hook. No block here → empty, so the banner renders nothing.
  useFileAccessBlocks: () => [],
}));

// Stub the org-scoped connected-agent probe (PRD-536 §5) so these SessionsView
// tests don't stand up the real API-client/auth providers just to render.
vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

vi.mock("@repo/app/agents/hooks/use-sessions-view-state", () => ({
  useSessionsViewState: hooks.useSessionsViewState,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  // ISS-4890/4906/4901 + ISS-4887: the shared table and summary strip read
  // their gates OPTIONALLY, so this module mock must expose both hooks or the
  // whole subtree throws on the missing export. Both resolve OFF here, which
  // is the flag default and the behavior these tests assert.
  useFeatureFlagEnabledOptional: () => false,
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: hooks.useSharedDateRange,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => navigation,
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/sessions",
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: hooks.useSearchParamsValue,
}));

vi.mock("../agent-coaching-tips", () => ({
  AgentCoachingTips: () => <div data-testid="agent-coaching-tips" />,
}));

// Force cloud mode without standing up the real app-core provider (QueryClient,
// adapters, IPC bridge). SessionsView imports only `useDesktopAppCoreMode` here.
vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => DesktopAppCoreMode.Cloud,
  // ISS-5477: SessionsView derives the read-source badge detail from the
  // same provider, so this factory has to answer for it too.
  useDesktopCloudReadCutover: () => drainedCutover(),
}));

// FEA-3574: SessionsView now reads the durable-session auth state to drive the
// cloud-only delivery cards' per-card auth state, so it calls `useDesktopAuth()`
// unconditionally. Stub the provider so these cloud-read-gate tests don't have to
// mount the real DesktopAuthProvider; the authenticated case keeps the delivery
// cards in the neutral-empty state (no sign-in CTA). The auth-state machine
// itself is covered by the shared sessions-summary-cards tests and the signed-out
// case in sessions-view-responsive.test.tsx.
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

// FEA-4128: the three always-available (local SQLite) cards — Sessions, Total
// Tokens, Cost — that skeleton while the local source hydrates.
const ALWAYS_AVAILABLE_CARD_COUNT = 3;

describe("SessionsView cloud mode", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "7d",
      setDateRange: vi.fn(),
    });
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
    hooks.useSessionsViewState.mockReturnValue({
      sortKey: null,
      sortDir: "desc",
      visibleColumns: new Set<string>(["name"]),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
    });
    // FEA-4157: the table + summary cards read from ONE combined
    // `useAgentSessionsPageData` ({ list, usage }); the facet-option toolbar read
    // stays on `useAgentSessionUsage`. In Cloud mode the always-available cards
    // additionally read `useLocalAgentSessionUsage` (the SQLite split below).
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          items: [{ id: "session-1" }],
          total: 50,
          readSource: undefined,
        },
        usage: {
          totalSessions: 50,
          totalInputTokens: 1000,
          totalOutputTokens: 250,
          earliestSessionAt: "2026-07-01T00:00:00.000Z",
          latestSessionAt: "2026-07-02T00:00:00.000Z",
          byRepository: [],
        },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    hooks.useAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 50,
        totalInputTokens: 1000,
        totalOutputTokens: 250,
        earliestSessionAt: "2026-07-01T00:00:00.000Z",
        latestSessionAt: "2026-07-02T00:00:00.000Z",
        byRepository: [],
      },
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
    });
    hooks.useAgentSessionAnalytics.mockReturnValue({
      data: { byRepository: [] },
    });
    // FEA-3574 review (wongk): the separate LOCAL usage read that backs the
    // always-available cards in Cloud mode. Defaults to a loaded local total so
    // the always-available cards render from SQLite, not the cloud read.
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 50,
        totalInputTokens: 1000,
        totalOutputTokens: 250,
        byRepository: [],
      },
      isError: false,
    });
    // FEA-4128: no first-launch import in flight by default, so the always-
    // available cards render their loaded local totals (the import-in-progress
    // skeleton path is exercised explicitly below).
    hooks.useIngestProgress.mockReturnValue(null);
    // Local monitor is UNAVAILABLE: getAgentMonitorUrl rejects, so the local
    // source status resolves to `unavailable` (never `ready`). In Local mode this
    // would gate the read off and show the unavailable state; cloud mode must not.
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentMonitorUrl: vi
          .fn()
          .mockRejectedValue(new Error("local monitor unavailable")),
        onDbChanged: vi.fn(() => undefined),
      },
    });
  });

  afterEach(() => {
    // Unmount before removing window.desktopApi: SessionsView's local-monitor
    // status effect runs a 500ms poll that reads window.desktopApi, so tearing
    // the global down while a component is still mounted leaks into the next test.
    cleanup();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  it("enables the cloud sessions query and renders rows even when the local monitor is unavailable", async () => {
    render(<SessionsView />);

    // The list renders (displayState collapsed to "ready"), not the local
    // "unavailable" empty state.
    await waitFor(() =>
      expect(screen.queryByTestId("sessions-table-body")).toBeTruthy()
    );

    // The read gate (`canReadSessions = isCloudMode || canReadLocalSessions`) is
    // true purely from cloud mode — the sessions query is enabled despite the
    // local monitor being unavailable.
    expect(hooks.useAgentSessionsPageData).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );

    // Sanity: the local monitor really was consulted and reported not-ready, so
    // the gate is driven by cloud mode, not by an accidental `ready` status.
    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(LOCAL_SESSION_SOURCE_STATUSES.unavailable).toBe("unavailable");
  });

  it("shares a stable UTC-day lower bound across remounts and auxiliary reads", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));

    try {
      render(<SessionsView />);
      const firstStartDate =
        hooks.useAgentSessionsPageData.mock.lastCall?.[0]?.startDate;
      expect(
        hooks.useLocalAgentSessionUsage.mock.lastCall?.[0]?.startDate
      ).toBe(firstStartDate);
      expect(hooks.useAgentSessionAnalytics.mock.lastCall?.[0]?.startDate).toBe(
        firstStartDate
      );
      cleanup();
      vi.setSystemTime(new Date("2026-08-07T23:59:59.999Z"));

      render(<SessionsView />);
      expect(hooks.useAgentSessionsPageData.mock.lastCall?.[0]?.startDate).toBe(
        firstStartDate
      );
      cleanup();
      vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));

      render(<SessionsView />);
      expect(
        hooks.useAgentSessionsPageData.mock.lastCall?.[0]?.startDate
      ).not.toBe(firstStartDate);
    } finally {
      vi.useRealTimers();
    }
  });

  // ISS-5809: the Sessions list is sorted by most recent activity, so a window
  // that stopped at yesterday 23:59:59.999 hid every session active TODAY and the
  // newest visible row aged through the day. This pins the Electron surface's own
  // request — the web page has the mirror assertion — because the window is
  // consumed by each shell's adapter, not by a shared component.
  it("requests a window that includes the in-progress UTC day", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));

    try {
      render(<SessionsView />);

      const filters = hooks.useAgentSessionsPageData.mock.lastCall?.[0];
      // Ends WITH today, not before it: activity from a minute ago is inside.
      expect(filters?.endDate).toBe("2026-08-07T23:59:59.999Z");
      expect(filters?.startDate).toBe("2026-08-01T00:00:00.000Z");
      expect(Date.parse(filters?.endDate ?? "")).toBeGreaterThan(Date.now());
      // The auxiliary local reads are deliberately NOT asserted for an upper
      // bound: they send only `startDate` (unchanged by ISS-5809), which already
      // reaches `now`, so they agree with the list window without carrying one.
      // Their shared LOWER bound is pinned by the sibling stability test above.
      expect(
        hooks.useLocalAgentSessionUsage.mock.lastCall?.[0]?.startDate
      ).toBe(filters?.startDate);
    } finally {
      vi.useRealTimers();
    }
  });

  // PLN-1138 Phase 4 (AC cloud-path correctness): the cloud read is
  // server-paginated. The one-based `page` query maps to a zero-based index and
  // a byte-offset window the SERVER slices — the view never fetches everything
  // and slices client-side.
  it("requests a server-paginated window keyed to the page query", async () => {
    // total 50 → 2 pages; `page=2` is the (valid, unclamped) second page.
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams("page=2"));

    render(<SessionsView />);

    // Drain the local-monitor status effect so its 500ms poll is torn down
    // before this test ends (it reads window.desktopApi, cleared in afterEach).
    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    // Second page (zero-based index 1) → offset 25 over a 25-row window.
    expect(hooks.useAgentSessionsPageData).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, offset: 25 }),
      expect.anything()
    );
  });

  // FEA-3560 regression: opening a session detail unmounts this view; returning
  // restores the list hash URL (the breadcrumb's preserved lastNavHref) but not
  // component state. The view must re-seed its facet filters from the URL on
  // mount so the restored view queries the FILTERED set at the restored page —
  // not page N of the unfiltered one.
  it("seeds facet filters from the hash URL on mount (detail→back restore)", async () => {
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams("owner=user-1&status=active&status=inactive&page=2")
    );

    render(<SessionsView />);

    // Drain the local-monitor status effect (see note above) before teardown.
    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(hooks.useAgentSessionsPageData).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 25,
        statuses: ["active", "inactive"],
        userIds: ["user-1"],
      }),
      expect.anything()
    );
  });

  // ISS-4429 (codex P1): a HEALTHY cloud read paints its real cloud values
  // immediately and must NOT skeleton behind a background local import. The cloud
  // `usage` (from beforeEach) reports totalSessions 50 — the SAME population the
  // table shows — so even with a first-launch import mid-flight the always-
  // available cards show the cloud numbers, never the FEA-4128 import skeleton
  // (which is now scoped to the cloud-FAILURE fallback path, covered below).
  it("paints the cloud values with no skeleton while a first-launch import runs (healthy cloud read wins)", async () => {
    // Import mid-flight: 6 of 7 sessions processed.
    hooks.useIngestProgress.mockReturnValue({
      byHarness: [],
      total: 7,
      processed: 6,
      preparing: false,
      complete: false,
    });
    // The local fallback read has not resolved yet — but the cloud read is healthy
    // (beforeEach), so the fallback (and its skeleton) never engages.
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: undefined,
      isError: false,
    });

    const { container } = render(<SessionsView />);

    await waitFor(() =>
      expect(screen.queryByTestId("sessions-table-body")).toBeTruthy()
    );
    // The cloud population (totalSessions 50) renders directly; no import skeleton
    // and no "Importing your history" caption on a healthy cloud read.
    expect(screen.queryByText("Sessions")).toBeTruthy();
    expect(screen.queryByText("50")).toBeTruthy();
    expect(screen.queryByText("Importing your history")).toBeNull();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();

    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
  });

  // ISS-4429 (codex P1): the FEA-4128 import skeleton now belongs on the cloud-
  // FAILURE fallback path. When the cloud `usage` read has FAILED (no cloud totals)
  // AND a first-launch import is mid-flight, the always-available cards wait on the
  // local fallback: they skeleton (with the "Importing your history" caption),
  // never a fabricated `0`, until ingestion finishes. The delivery cards dash on
  // the cloud failure, but the three always-available cards must not lie about a
  // still-filling store.
  it("skeletons the always-available cards while an import runs on the cloud-failure fallback path", async () => {
    // Cloud usage read FAILED with no totals in hand — the fallback engages.
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: true,
    });
    // Import mid-flight, local fallback read not resolved yet.
    hooks.useIngestProgress.mockReturnValue({
      byHarness: [],
      total: 7,
      processed: 6,
      preparing: false,
      complete: false,
    });
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: undefined,
      isError: false,
    });

    const { container } = render(<SessionsView />);

    await waitFor(() =>
      expect(screen.queryByTestId("sessions-table-body")).toBeTruthy()
    );
    // Card frames stay — labels + the import reason caption visible — with only the
    // value slots skeletoned, never a fabricated `0`.
    expect(screen.queryByText("Sessions")).toBeTruthy();
    expect(screen.queryByText("Total Tokens")).toBeTruthy();
    expect(screen.getAllByText("Importing your history").length).toBe(
      ALWAYS_AVAILABLE_CARD_COUNT
    );
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(
      ALWAYS_AVAILABLE_CARD_COUNT
    );

    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
  });

  // ISS-4429 (codex P1): the true first-launch race, now on the cloud-FAILURE
  // fallback path. The local IPC usage read RESOLVES to a still-zero summary while
  // the db-host import is mid-flight (`data` is a defined zero object, not
  // `undefined`), so a "read settled" gate would mask the import signal and render
  // a hard `0`. With the cloud read failed and the import active, the skeleton must
  // still hold over the resolved-but-still-zero read.
  it("skeletons on the cloud-failure path even after the local read resolves to a still-zero summary", async () => {
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: true,
    });
    hooks.useIngestProgress.mockReturnValue({
      byHarness: [],
      total: 7,
      processed: 6,
      preparing: false,
      complete: false,
    });
    // The local read HAS resolved — but to the still-zero summary the store holds
    // mid-import. Without the import signal outranking it, this reads as `0`.
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        apiEstimatedCost: 0,
        byRepository: [],
      },
      isError: false,
    });

    const { container } = render(<SessionsView />);

    await waitFor(() =>
      expect(screen.queryByTestId("sessions-table-body")).toBeTruthy()
    );
    // Card frames stay — labels + reason caption visible — with only the value
    // slots skeletoned, even though the local read already RESOLVED (to zero).
    expect(screen.queryByText("Sessions")).toBeTruthy();
    expect(screen.queryByText("Total Tokens")).toBeTruthy();
    expect(screen.getAllByText("Importing your history").length).toBe(
      ALWAYS_AVAILABLE_CARD_COUNT
    );
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(
      ALWAYS_AVAILABLE_CARD_COUNT
    );

    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
  });

  it("renders a genuine 0 on the Sessions card when the cloud read is confirmed-empty", async () => {
    // ISS-4429: cloud-primary. A confirmed-empty CLOUD read (totalSessions 0, no
    // error) is the truth — the cards show `0`, never a skeleton or a fallback to
    // a stale local number. No import in flight.
    hooks.useIngestProgress.mockReturnValue(null);
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: { items: [], total: 0, readSource: undefined },
        usage: {
          totalSessions: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          byRepository: [],
        },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    // A populated local store must NOT override the confirmed-empty cloud read —
    // that override was the ISS-4429 divergence. The cards read the cloud `0`.
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 99,
        totalInputTokens: 5,
        totalOutputTokens: 5,
        apiEstimatedCost: 1,
        byRepository: [],
      },
      isError: false,
    });

    const { container } = render(<SessionsView />);

    await waitFor(() => expect(screen.queryByText("Sessions")).toBeTruthy());
    // The confirmed-empty cloud population shows `0`, no skeleton, and the local
    // 99 never leaks in.
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("99")).toBeNull();

    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
  });

  // ISS-4429 (wongk review): the fallback must be REACHABLE on a fresh cloud
  // failure. `canFetchAuxiliaryData` gates on the cloud list settling, so a cloud
  // `pageData` that REJECTS on first load leaves it false — the old enable gate
  // would keep the local read disabled and the cards would dash with neither
  // cloud nor local totals. The enable must fire on the cloud-failure state too,
  // so the local fallback read is issued and its totals back the cards.
  it("enables the local fallback read on a fresh cloud failure (no settled list data)", async () => {
    // Cloud read failed on first load: no list, no usage, no placeholder.
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: true,
    });
    hooks.useIngestProgress.mockReturnValue(null);
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 42,
        totalInputTokens: 100,
        totalOutputTokens: 20,
        apiEstimatedCost: 3,
        byRepository: [],
      },
      isError: false,
    });

    render(<SessionsView />);

    await waitFor(() =>
      expect(screen.queryByTestId("sessions-table-body")).toBeTruthy()
    );
    // The local fallback read was ENABLED despite the cloud list never settling.
    await waitFor(() =>
      expect(hooks.useLocalAgentSessionUsage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ enabled: true })
      )
    );
    // Its totals back the always-available cards (42), and the source-honest
    // fallback caption names where the number came from.
    expect(screen.queryByText("42")).toBeTruthy();
    expect(screen.getAllByText("From local history").length).toBe(
      ALWAYS_AVAILABLE_CARD_COUNT
    );

    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
  });

  // Column sort is applied server-side: an active sort key round-trips into the
  // query (sortBy/sortDir) so the server's ORDER BY decides the order — the view
  // must not re-sort the returned rows locally.
  it("forwards an active column sort into the server query", async () => {
    hooks.useSessionsViewState.mockReturnValue({
      sortKey: SessionSortKey.Started,
      sortDir: SessionSortDir.Asc,
      visibleColumns: new Set<string>(["name"]),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
    });

    render(<SessionsView />);

    // Drain the local-monitor status effect (see note above) before teardown.
    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(hooks.useAgentSessionsPageData).toHaveBeenCalledWith(
      expect.objectContaining({
        sortBy: SessionSortKey.Started,
        sortDir: SessionSortDir.Asc,
      }),
      expect.anything()
    );
  });
});
