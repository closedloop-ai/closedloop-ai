// The real row catalog drives how many row bodies the ready state renders — keep
// it unmocked so the "renders every row" assertion stays honest if rows change.

import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { REFRESHING_ONSET_MS } from "@repo/app/insights/components/overview/dashboard-refreshing";
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
import type { AgentsInsightsResponse } from "@closedloop-ai/loops-api/insights";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../dashboard-storage-keys";
import { FirstLaunchDashboard } from "../first-launch-dashboard";
import { buildTourSteps } from "../tour/build-tour-steps";

const ANALYZING_TEXT = /Analyzing locally/;
// FEA-4020: the single header "Refreshing" indicator's copy.
const REFRESHING_RE = /refreshing/i;

type DashboardRowContentPropsForTest = {
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  onConnectGitHub?: () => void | Promise<void>;
  modelSeries?: unknown;
  modelTokenSeries?: unknown;
  frustrationSeries?: unknown;
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
  // ISS-6002: what the local session source reports. Mutable so a test can hold
  // the store closed and assert the page does NOT claim an empty install, or
  // report it terminally unavailable and assert the skeleton clears.
  sessionSource: { value: { ready: true, unavailable: false } },
}));

// ISS-5112: the page reads desktop auth + the guest-onboarding Labs flag to
// decide whether finishing the tour offers an account. Neither is this suite's
// subject (see guest-tour-account-dialog.test.tsx), but `useDesktopAuth` throws
// without its provider, so stub it at a signed-out default. Set from the enum in
// `beforeEach` rather than inside the factory: a `vi.mock` factory is evaluated
// during the import phase, before this file's own imports are initialized.
const authState = vi.hoisted(() => ({ status: "" as string }));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: authState.status, userId: null, organizationId: null },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
// The harness row's local SQLite read needs a QueryClient; the flag is off in
// every test here, so stub the hook to its flag-off answer rather than stand one
// up. The real read is exercised in guest-tour-account-dialog.test.tsx.
vi.mock("../tour/use-tour-harnesses", () => ({
  // `ready: true` — the tour's arming gate now waits on this read, so a mock
  // that never settles would hold the tour shut and pass the arming tests
  // vacuously.
  useTourHarnesses: () => ({ harnesses: [], ready: true }),
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));
// ISS-6002: the source probe is the seam, not the subject — it reaches the local
// agent-monitor over IPC and the app-core mode context. Stub ONLY that hook and
// keep the real `resolveDashboardState` / `useSessionsCountFresh` /
// `useBackfillSettleDetection`, so the state machine this suite asserts on — and
// the freshness rule the count is gated by — is the shipped one.
vi.mock("../dashboard-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-state")>()),
  useDashboardSessionSource: () => hooks.sessionSource.value,
}));
vi.mock("@repo/app/insights/hooks/use-insights", () => ({
  insightsKeys: { all: ["insights"] },
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});
// Mutable so a test can flip the selected range between renders — the FEA-4020
// header "Refreshing" indicator is gated on this user-driven period changing.
const dashboardRange = { period: "30d" };
vi.mock("@repo/app/insights/hooks/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    dateRange: "30d",
    setDateRange: vi.fn(),
    period: dashboardRange.period,
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
// Out of scope for the view-state machine: the read-source badge owns its own
// app-core-mode hook (covered by dashboard-read-source-badge.test.tsx).
vi.mock("../dashboard-read-source-badge", () => ({
  DashboardReadSourceBadge: () => null,
}));
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

type SessionsFixture = {
  data: { total: number; items: unknown[] } | undefined;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
};

// The fixture most recently built — `landFreshSessionsPoll` advances it rather
// than reading it back off the mock (calling `hooks.useAgentSessions()` from a
// plain function reads as a rules-of-hooks violation).
let currentSessionsFixture: SessionsFixture;

function sessionsResult(overrides: Partial<SessionsFixture> = {}) {
  currentSessionsFixture = {
    data: { total: 0, items: [] },
    isLoading: false,
    // ISS-6002: the page now reads this. A resolved read reports `isSuccess`;
    // the point of the fix is that a total without one is not a real zero.
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 1,
    ...overrides,
  };
  return currentSessionsFixture;
}

function insightResult(
  overrides: Partial<{
    isSuccess: boolean;
    isError: boolean;
    isFetching: boolean;
    data: unknown;
  }> = {}
) {
  return {
    isSuccess: false,
    isLoading: false,
    isError: false,
    isFetching: false,
    data: undefined,
    ...overrides,
  };
}

// All three insights sections resolved — `analyticsLoaded` is true, so the page
// leaves the loading treatment. agents.data must carry the minimal shape
// buildTourSteps reads (kpis + modelBreakdown).
function allInsightsLoaded() {
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: { kpis: [], charts: {} } })
  );
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: { kpis: [], charts: {} } })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({
      isSuccess: true,
      data: {
        kpis: [],
        charts: {
          modelBreakdown: [],
          // ISS-5280 (review): the agent-pipeline row is dropped when the Agents
          // section resolves without nodes, so the default "loaded" fixture
          // seeds a populated graph — otherwise every row-count assertion below
          // would silently be counting one row fewer for the wrong reason.
          agentPipeline: {
            nodes: [{ id: "researcher", label: "researcher", value: 4 }],
            edges: [],
          },
        },
      },
    })
  );
}

// The ready-state dashboard renders insights tiles gated by `<FeatureFlagged>`,
// which require a `FeatureFlagAdapterProvider` ancestor (the real app mounts one
// via DesktopAppCoreProvider). Wrap renders in a static adapter so the gated
// subtree resolves without a live PostHog surface.
/**
 * ISS-6002 (review cid 3761648058): land one more poll on the mocked read.
 *
 * The page distrusts a result that PREDATES the local store proving it can serve
 * rows, so a fixture whose only read landed at mount is not yet a known count —
 * that stale result is exactly the pre-store zero the fix exists to distrust.
 * Advancing `dataUpdatedAt` (which react-query moves only on a successful fetch)
 * and re-rendering is what the real 2.5s poll does. A no-op for a read that is
 * still pending or has errored: those hold no result to be fresh about.
 */
function landFreshSessionsPoll(rerender: (ui: ReactElement) => void) {
  currentSessionsFixture = {
    ...currentSessionsFixture,
    dataUpdatedAt: currentSessionsFixture.dataUpdatedAt + 1,
  };
  hooks.useAgentSessions.mockReturnValue(currentSessionsFixture);
  act(() => {
    rerender(<FirstLaunchDashboard />);
  });
}

function renderDashboard(
  sourceOverrides: Partial<InsightsDataSource> = {},
  enabledFlags: string[] = []
) {
  const source = createInsightsSource(sourceOverrides);
  const result = render(<FirstLaunchDashboard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <InsightsDataSourceProvider value={source}>
          {children}
        </InsightsDataSourceProvider>
      </FeatureFlagAdapterProvider>
    ),
  });
  landFreshSessionsPoll(result.rerender);
  return { ...result, source };
}

beforeEach(() => {
  authState.status = DesktopAuthStatus.SignedOut;
});

describe("FirstLaunchDashboard view-state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboardRange.period = "30d";
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
    hooks.sessionSource.value = { ready: true, unavailable: false };
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

  // ISS-6002: what the page may CLAIM about a count it does not have — an
  // unsettled or unserviceable zero, on the body and in the header — is its own
  // suite: dashboard-unsettled-zero.test.tsx.

  it("renders every dashboard row once analytics load and sessions exist", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    // ISS-5061 re-gate: seed the Agent Collaboration Network toggle ON so this
    // still means "every row". With it off that row is absent by design, which
    // is covered by its own gate-off test below.
    renderDashboard({}, [DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    // Guard against a vacuous match if the catalog were ever empty.
    expect(DASHBOARD_ROWS.length).toBeGreaterThan(0);
    // FEA-4022 (T5/T20): the frustration row is dropped once the Agents section
    // resolves WITHOUT a frustrationTrend (allInsightsLoaded seeds no series),
    // so it never renders a permanent skeleton on desktop. Every other row
    // renders.
    const frustrationRows = DASHBOARD_ROWS.filter(
      (row) => row.tour === "frustration"
    ).length;
    expect(frustrationRows).toBe(1);
    expect(screen.getAllByTestId("dashboard-row")).toHaveLength(
      DASHBOARD_ROWS.length - frustrationRows
    );
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByText("No agent sessions yet")).toBeNull();
  });

  // ISS-5061 re-gate (reverses ISS-5280 for this one flag): the Agent
  // Collaboration Network row is closed-by-default on desktop again.
  // `renderDashboard` seeds NO enabled flags, so this is the gate-OFF case —
  // the row must be ABSENT, not an empty card. Driven with the Agents section
  // RESOLVED and WITH pipeline nodes, so the absence can only come from the
  // gate and not from the row's separate absent-data filter.
  it("omits the agent-collaboration row on desktop when the Labs toggle is off", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    expect(
      hooks.DashboardRowContent.mock.calls.some(
        ([props]) => props.row.tour === "agent-pipeline"
      )
    ).toBe(false);
  });

  // Gate-ON counterpart. Same resolved data as above, so the ONLY difference is
  // the seeded Labs flag — without the gate wiring this pair cannot both pass.
  it("renders the agent-collaboration row on desktop when the Labs toggle is on", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard({}, [DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    expect(
      hooks.DashboardRowContent.mock.calls.some(
        ([props]) => props.row.tour === "agent-pipeline"
      )
    ).toBe(true);
  });

  // ISS-5280 (review): the same absent-data filter the frustration row has.
  // A Local-mode install whose sessions spawn no subagents resolves the Agents
  // section without pipeline nodes; without this the row would draw a permanent
  // empty 340px card. Desktop must match the web shell here.
  it("drops the agent-collaboration row when Agents resolves without nodes", () => {
    allInsightsLoaded();
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { kpis: [], charts: { modelBreakdown: [] } },
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    // ISS-5061 re-gate: the toggle is seeded ON deliberately, so the row is
    // dropped by the ABSENT-DATA filter and not by the gate. Without this the
    // assertion below would pass for the wrong reason and stop covering the
    // filter it names.
    renderDashboard({}, [DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    expect(
      hooks.DashboardRowContent.mock.calls.some(
        ([props]) => props.row.tour === "agent-pipeline"
      )
    ).toBe(false);
    // A rowmate that does not depend on pipeline data still renders, so this is
    // a targeted drop rather than the whole dashboard failing to mount.
    expect(
      hooks.DashboardRowContent.mock.calls.some(
        ([props]) => props.row.tour === "models"
      )
    ).toBe(true);
  });

  // FEA-4000: the AI Impact card graduated off its `aiImpactCardEnabled` Labs flag
  // and now mounts unconditionally. `renderDashboard` seeds NO enabled flags, so
  // this asserts the real (unmocked) card renders on desktop with an empty flag
  // set — a regression guard against the Labs gate silently returning. The card is
  // imported unmocked here, so this also exercises its full derive-and-render path
  // (deriveAiImpact over the resolved sections) rather than a null stub.
  it("mounts the AI Impact card with no feature flags enabled", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    expect(screen.getByText("AI Impact")).toBeDefined();
  });

  // FEA-4020: after the initial load, a user-driven range/scope change refetches
  // the section queries. Because `keepPreviousData` keeps each section
  // settled-success (so the page stays in the ready branch), the refresh is
  // signaled by a SINGLE header "Refreshing" indicator — not a dimmed overlay on
  // every row (which strobed on the ~2s Recent-Sessions poll and tore widget
  // subtrees down on the flip). It is gated on the range changing and debounced
  // past an onset delay.
  it("shows a single header 'Refreshing' indicator (no dimmed rows) on a user-driven range refresh", () => {
    vi.useFakeTimers();
    try {
      // First render: settled at the 30d range.
      allInsightsLoaded();
      hooks.useAgentSessions.mockReturnValue(
        sessionsResult({ data: { total: 5, items: [] } })
      );
      const { container, rerender } = renderDashboard();
      expect(screen.queryByText(REFRESHING_RE)).toBeNull();

      // User switches the range → new request key, every section refetches over
      // its prior data.
      dashboardRange.period = "7d";
      hooks.useDeliveryInsights.mockReturnValue(
        insightResult({ isSuccess: true, isFetching: true, data: {} })
      );
      hooks.useUtilizationInsights.mockReturnValue(
        insightResult({
          isSuccess: true,
          isFetching: true,
          data: { charts: {} },
        })
      );
      hooks.useAgentsInsights.mockReturnValue(
        insightResult({
          isSuccess: true,
          isFetching: true,
          data: { kpis: [], charts: { modelBreakdown: [] } },
        })
      );
      act(() => {
        rerender(<FirstLaunchDashboard />);
      });
      act(() => {
        vi.advanceTimersByTime(REFRESHING_ONSET_MS + 50);
      });

      // The dashboard stays in the ready state (rows render, not loading)...
      expect(screen.queryByTestId("dashboard-loading")).toBeNull();
      expect(screen.getAllByTestId("dashboard-row").length).toBeGreaterThan(0);
      // ...one header "Refreshing" indicator shows...
      expect(screen.getAllByText(REFRESHING_RE)).toHaveLength(1);
      // ...and NO row is dimmed under an aria-busy overlay (the old per-row
      // treatment is gone).
      expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(0);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("does not flash the indicator for a background refetch at the SAME range (e.g. the ~2s Recent-Sessions poll)", () => {
    vi.useFakeTimers();
    try {
      allInsightsLoaded();
      hooks.useAgentSessions.mockReturnValue(
        sessionsResult({ data: { total: 5, items: [] } })
      );
      const { rerender } = renderDashboard();

      // Sections refetch WITHOUT a range change (a db-change invalidation / poll):
      // isFetching flips true but the request key is unchanged.
      hooks.useDeliveryInsights.mockReturnValue(
        insightResult({ isSuccess: true, isFetching: true, data: {} })
      );
      hooks.useUtilizationInsights.mockReturnValue(
        insightResult({
          isSuccess: true,
          isFetching: true,
          data: { charts: {} },
        })
      );
      hooks.useAgentsInsights.mockReturnValue(
        insightResult({
          isSuccess: true,
          isFetching: true,
          data: { kpis: [], charts: { modelBreakdown: [] } },
        })
      );
      act(() => {
        rerender(<FirstLaunchDashboard />);
        vi.advanceTimersByTime(REFRESHING_ONSET_MS + 50);
      });

      expect(screen.queryByText(REFRESHING_RE)).toBeNull();
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("shows no refreshing indicator once every section has settled (not fetching)", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    const { container } = renderDashboard();

    expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(0);
    expect(screen.queryByText(REFRESHING_RE)).toBeNull();
  });

  it("renders the frustration row (with its series) once the Agents section returns a frustrationTrend (T5/T20)", () => {
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: true, data: {} })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({ isSuccess: true, data: { charts: {} } })
    );
    const frustrationTrend = {
      series: [{ key: "frustration", label: "Frustration" }],
      points: [{ date: "2026-06-08", values: { frustration: 42 } }],
    };
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: {
          kpis: [],
          charts: {
            modelBreakdown: [],
            frustrationTrend,
            // Seeded so the full-count assertion below measures the frustration
            // row landing, not the agent-pipeline row dropping for absent nodes.
            agentPipeline: {
              nodes: [{ id: "researcher", label: "researcher", value: 4 }],
              edges: [],
            },
          },
        },
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    // ISS-5061 re-gate: the agent-collaboration toggle is seeded ON so the
    // full-count assertion below still measures the frustration row landing,
    // rather than that row dropping for its gate.
    renderDashboard({}, [DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    // The frustration row now renders, and it is passed the series (not the
    // undefined that caused the permanent skeleton). With both data-dependent
    // rows populated and the agent-collaboration gate open, EVERY row draws.
    expect(screen.getAllByTestId("dashboard-row")).toHaveLength(
      DASHBOARD_ROWS.length
    );
    const frustrationProps = hooks.DashboardRowContent.mock.calls.find(
      ([props]) => props.row.tour === "frustration"
    )?.[0];
    expect(frustrationProps?.frustrationSeries).toEqual(frustrationTrend);
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

  it("threads both model spend and token series into the Model Usage row (FEA-3497)", () => {
    // The $/# toggle needs BOTH series: forwarding only `modelUsageOverTime`
    // left `modelTokenSeries` undefined, so switching to `#` on desktop showed
    // the skeleton instead of the token chart. Assert the desktop caller passes
    // `modelTokensOverTime` through alongside the spend series.
    const modelUsageOverTime = { points: [], series: [] };
    const modelTokensOverTime = { points: [], series: [] };
    allInsightsLoaded();
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: {
          kpis: [],
          charts: {
            modelBreakdown: [],
            modelUsageOverTime,
            modelTokensOverTime,
          },
        },
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    const modelsProps = hooks.DashboardRowContent.mock.calls.find(
      ([props]) => props.row.tour === "models"
    )?.[0];
    if (!modelsProps) {
      throw new Error("Expected a Model Usage (models) dashboard row");
    }
    expect(modelsProps.modelSeries).toBe(modelUsageOverTime);
    expect(modelsProps.modelTokenSeries).toBe(modelTokensOverTime);
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
    const prsStep = buildTourSteps({
      sessionsTotal: 12,
      agents,
      guestOnboardingEnabled: false,
      harnesses: [],
    }).find((step) => "sel" in step && step.sel === "prs");

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
    // The flags gate the whole first-launch flow (firstLaunch/onboarded/
    // tour-seen), and this env has no real localStorage to hold them.
    stubLocalStorage();
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
