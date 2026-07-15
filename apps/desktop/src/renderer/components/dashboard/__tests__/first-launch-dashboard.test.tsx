// The real row catalog drives how many row bodies the ready state renders — keep
// it unmocked so the "renders every row" assertion stays honest if rows change.

import type { AgentsInsightsResponse } from "@closedloop-ai/loops-api/insights";
import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { DASHBOARD_ROWS } from "@repo/app/insights/components/overview/dashboard-tiles";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import type { InsightsTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import { getTile } from "@repo/app/insights/lib/tile-catalog";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../dashboard-storage-keys";
import {
  buildTourSteps,
  FirstLaunchDashboard,
} from "../first-launch-dashboard";

const ANALYZING_TEXT = /Analyzing locally/;

type DashboardRowContentPropsForTest = {
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  onConnectGitHub?: () => void | Promise<void>;
  row: { tour: string };
};

// The view-state machine is fed entirely by these data hooks; drive them
// directly so each branch (loading / empty / ready / analyzing / error) is
// reachable without a live SQLite-backed insights provider.
const hooks = vi.hoisted(() => ({
  DashboardRowContent:
    vi.fn<(props: DashboardRowContentPropsForTest) => void>(),
  Tour: vi.fn<(props: { active: boolean }) => void>(),
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));
vi.mock("@repo/app/insights/hooks/use-insights", () => ({
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));
vi.mock("@repo/app/insights/hooks/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    dateRange: "30d",
    setDateRange: vi.fn(),
    period: "30d",
    periodLabel: "Last 30 days",
    deltaLabel: "vs. prior 30 days",
  }),
}));

// Heavy presentational children are out of scope here — stub them to markers so
// the test isolates the page's routing logic, not the row/table/tour internals.
vi.mock("@repo/app/insights/components/overview/dashboard-rows", () => ({
  DashboardRowContent: (props: DashboardRowContentPropsForTest) => {
    hooks.DashboardRowContent(props);
    return <div data-testid="dashboard-row" />;
  },
}));
vi.mock("@repo/app/shared/components/date-range-filter", () => ({
  DateRangeFilter: () => null,
}));
vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
}));
vi.mock("../dashboard-loading", () => ({
  DashboardLoading: ({ analyticsPct }: { analyticsPct: number }) => (
    <div data-analytics-pct={analyticsPct} data-testid="dashboard-loading" />
  ),
}));
vi.mock("../tour/tour", () => ({
  Tour: (props: { active: boolean }) => {
    hooks.Tour(props);
    return null;
  },
}));
vi.mock("../tour/tour-hint", () => ({ TourHint: () => null }));
vi.mock("../layout/page-shell", () => ({
  PageShell: ({
    actions,
    children,
  }: {
    actions: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
  DashboardCard: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

function sessionsResult(
  overrides: Partial<{
    data: { total: number; items: unknown[] } | undefined;
    isLoading: boolean;
    isError: boolean;
    dataUpdatedAt: number;
  }> = {}
) {
  return {
    data: { total: 0, items: [] },
    isLoading: false,
    isError: false,
    dataUpdatedAt: 1,
    ...overrides,
  };
}

function insightResult(
  overrides: Partial<{ isSuccess: boolean; data: unknown }> = {}
) {
  return {
    isSuccess: false,
    isLoading: false,
    isError: false,
    data: undefined,
    ...overrides,
  };
}

// All three insights sections resolved — `analyticsLoaded` is true, so the page
// leaves the loading treatment. agents.data must carry the minimal shape
// buildTourSteps reads (kpis + modelBreakdown).
function allInsightsLoaded() {
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: {} })
  );
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: { charts: {} } })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({
      isSuccess: true,
      data: { kpis: [], charts: { modelBreakdown: [] } },
    })
  );
}

// The ready-state dashboard renders insights tiles gated by `<FeatureFlagged>`,
// which require a `FeatureFlagAdapterProvider` ancestor (the real app mounts one
// via DesktopAppCoreProvider). Wrap renders in a static adapter so the gated
// subtree resolves without a live PostHog surface.
function renderDashboard(sourceOverrides: Partial<InsightsDataSource> = {}) {
  const source = createInsightsSource(sourceOverrides);
  const result = render(<FirstLaunchDashboard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <InsightsDataSourceProvider value={source}>
          {children}
        </InsightsDataSourceProvider>
      </FeatureFlagAdapterProvider>
    ),
  });
  return { ...result, source };
}

describe("FirstLaunchDashboard view-state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force reduced-motion so `motion` is false: the first-launch reveal scan is
    // skipped (tick starts at 100) and the state machine is deterministic,
    // independent of localStorage onboarding flags.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    hooks.useAgentSessions.mockReturnValue(sessionsResult());
  });

  afterEach(() => {
    // matchMedia is stubbed per-test above; restore it so the global doesn't
    // leak into other renderer suites.
    vi.unstubAllGlobals();
  });

  it("holds the loading treatment until every insights section resolves", () => {
    allInsightsLoaded();
    // One section still pending → analyticsLoaded false → loading branch.
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false })
    );

    renderDashboard();

    expect(screen.getByTestId("dashboard-loading")).toBeDefined();
    expect(screen.queryByText("No agent sessions yet")).toBeNull();
    expect(screen.queryByTestId("dashboard-row")).toBeNull();
  });

  it("renders the empty state once analytics load with no local sessions", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard();

    expect(screen.getByText("No agent sessions yet")).toBeDefined();
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByTestId("dashboard-row")).toBeNull();
    expect(screen.queryByText("Computed on this device")).toBeNull();
  });

  it("renders every dashboard row once analytics load and sessions exist", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    // Guard against a vacuous match if the catalog were ever empty.
    expect(DASHBOARD_ROWS.length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("dashboard-row")).toHaveLength(
      DASHBOARD_ROWS.length
    );
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByText("No agent sessions yet")).toBeNull();
  });

  it("passes provider-owned GitHub gating and connect action to dashboard rows", () => {
    const onConnectGitHub = vi.fn();
    const getTileAvailability = vi.fn(() => ({
      state: BranchKpiState.Gated,
    }));
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard({ getTileAvailability, onConnectGitHub });

    const statsProps = hooks.DashboardRowContent.mock.calls.find(
      ([props]) => props.row.tour === "stats"
    )?.[0];
    const mergedTile = getTile("kpi:merged");
    if (!(statsProps && mergedTile)) {
      throw new Error("Expected stats row props and merged KPI tile");
    }
    expect(statsProps.getTileAvailability?.(mergedTile)).toEqual({
      state: BranchKpiState.Gated,
    });
    expect(getTileAvailability).toHaveBeenCalledWith({
      tileId: mergedTile.id,
      section: InsightsSection.Delivery,
      scope: InsightsScope.Me,
    });

    statsProps.onConnectGitHub?.();

    expect(onConnectGitHub).toHaveBeenCalledTimes(1);
  });

  it("shows the analyzing scan status while the session feed is loading", () => {
    // Sessions still loading and analytics unresolved → analyzing indicator.
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: undefined, isLoading: true })
    );
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({ isSuccess: false })
    );
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({ isSuccess: false })
    );

    renderDashboard();

    expect(screen.getByText(ANALYZING_TEXT)).toBeDefined();
    expect(screen.queryByText("Computed on this device")).toBeNull();
  });

  it("omits the settled local-computation badge in the ready state", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    expect(screen.queryByText("Computed on this device")).toBeNull();
    expect(screen.queryByText(ANALYZING_TEXT)).toBeNull();
  });

  it("surfaces the recent-sessions error fallback inside the ready state", () => {
    allInsightsLoaded();
    // Ready (data present) but the session feed errored on refetch.
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] }, isError: true })
    );

    renderDashboard();

    expect(
      screen.getByText("Recent sessions are temporarily unavailable.")
    ).toBeDefined();
    expect(screen.queryByTestId("synced-sessions-table")).toBeNull();
  });

  it("describes the PR tour step without stale side-by-side repository copy", () => {
    const agents: AgentsInsightsResponse = {
      kpis: [],
      charts: {
        modelBreakdown: [],
        modelUsageOverTime: { points: [], series: [] },
      },
    };
    const prsStep = buildTourSteps(12, agents).find(
      (step) => "sel" in step && step.sel === "prs"
    );

    expect(prsStep?.body).toContain("repository-level shipping patterns");
    expect(prsStep?.body).not.toContain("right beside");
  });
});

// FEA-2737: the first-launch tour must not be permanently suppressed when the
// window is backgrounded (or the dashboard is otherwise off screen) at the
// moment the reveal settles. The onboarded latch/flag may only be committed
// once the tour is actually armed, and arming must re-evaluate when the window
// returns to the foreground.
describe("FirstLaunchDashboard first-launch tour arming (FEA-2737)", () => {
  let visibility: DocumentVisibilityState;
  // Whether the tour button reports as laid out (`offsetParent != null`). jsdom
  // never lays anything out, so drive this explicitly to exercise BOTH halves
  // of the component's on-screen guard (window visibility AND button layout).
  let laidOut: boolean;
  // Mirrors REVEAL_DURATION_MS in first-launch-dashboard.tsx (the reveal scan
  // length); the constant is module-private, so keep this in sync with it.
  const REVEAL_DURATION_MS = 3600;

  // Advance the dashboard from mount to the point the arming effect evaluates:
  //   1. run out the first-launch reveal scan so `tick` reaches 100, then
  //   2. feed consecutive no-growth session polls (advancing dataUpdatedAt,
  //      holding the total) so the backfill "settles".
  // Both are driven under fake timers inside a single act() so state flushes.
  function driveToArmable(rerender: (ui: ReactElement) => void) {
    act(() => {
      // Reveal uses a Date.now()-based interval; fake timers advance the clock.
      vi.advanceTimersByTime(REVEAL_DURATION_MS + 200);
    });
    for (let dataUpdatedAt = 2; dataUpdatedAt <= 4; dataUpdatedAt++) {
      hooks.useAgentSessions.mockReturnValue(
        sessionsResult({ data: { total: 5, items: [] }, dataUpdatedAt })
      );
      act(() => {
        rerender(<FirstLaunchDashboard />);
      });
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // This renderer test env has no real localStorage, but the flags gate the
    // whole first-launch flow — back it with an in-memory store so `readFlag` /
    // `writeFlag` (and thus firstLaunch/onboarded/tour-seen) behave as in-app.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    });
    // First-launch path: no onboarded flag → `firstLaunch` is true, and full
    // motion (NOT reduced) so the reveal scan actually runs and `tick` climbs
    // to 100 under fake timers — the arming effect waits on that completion.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    // jsdom performs no layout, so `offsetParent` is always null and the tour
    // button would never read as "laid out". Drive it via `laidOut` so tests
    // can exercise the button-layout half of the on-screen guard independently.
    laidOut = true;
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
      () => (laidOut ? document.body : null)
    );
    visibility = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );
  });

  afterEach(() => {
    // Drop any pending timers WITHOUT running them — a leftover 650ms arm timer
    // fired here would call setTourActive outside act() and warn.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // Drop the own `visibilityState` override so the prototype getter is
    // restored (assigning `= undefined` would throw — it is getter-only).
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("defers arming (and the onboarded flag) while the window is hidden, then arms once it is foregrounded", () => {
    visibility = "hidden";

    const { rerender } = renderDashboard();
    driveToArmable(rerender);

    // Hidden at settle: the latch/flag must NOT be committed and the tour must
    // stay closed — the previous bug persisted the flag here, killing the tour
    // forever on the next launch.
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
    const tourCallsWhileHidden = hooks.Tour.mock.calls;
    expect(
      tourCallsWhileHidden.every(([props]) => props.active === false)
    ).toBe(true);

    // Window returns to the foreground: arming re-evaluates and the tour opens.
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(650);
    });

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    const lastTourCall = hooks.Tour.mock.calls.at(-1);
    expect(lastTourCall?.[0].active).toBe(true);
  });

  it("arms immediately and persists the onboarded flag when on screen at settle", () => {
    visibility = "visible";

    const { rerender } = renderDashboard();
    driveToArmable(rerender);
    act(() => {
      vi.advanceTimersByTime(650);
    });

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    const lastTourCall = hooks.Tour.mock.calls.at(-1);
    expect(lastTourCall?.[0].active).toBe(true);
  });

  it("defers arming while the tour button is not laid out, even with a visible window", () => {
    // Window is visible, but the dashboard is behind the keep-alive map (its
    // subtree is display:none, so the tour button has no offsetParent). This
    // guards the layout half of the on-screen check — arming must NOT commit.
    visibility = "visible";
    laidOut = false;

    const { rerender } = renderDashboard();
    driveToArmable(rerender);
    act(() => {
      vi.advanceTimersByTime(650);
    });

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
    expect(
      hooks.Tour.mock.calls.every(([props]) => props.active === false)
    ).toBe(true);
  });

  it("does not re-open the tour once it has already been seen", () => {
    visibility = "visible";
    localStorage.setItem(dashboardTourSeenStorageKey, "1");

    const { rerender } = renderDashboard();
    driveToArmable(rerender);
    act(() => {
      vi.advanceTimersByTime(650);
    });

    // Onboarding still latches, but the guided tour stays closed on replay-only.
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    expect(
      hooks.Tour.mock.calls.every(([props]) => props.active === false)
    ).toBe(true);
  });
});

function createInsightsSource(
  overrides: Partial<InsightsDataSource> = {}
): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getAgents: vi.fn(),
    getDelivery: vi.fn(),
    getUtilization: vi.fn(),
    ...overrides,
  };
}
