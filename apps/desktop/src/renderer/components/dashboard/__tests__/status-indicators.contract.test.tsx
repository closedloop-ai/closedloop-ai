// FEA-2650: Status-indicator semantic contract pins — DELTA ONLY over the
// existing first-launch-dashboard.test.tsx coverage. Each describe block cites
// the production formula it pins and the FEA-2650 ticket.

import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { FirstLaunchDashboard } from "../first-launch-dashboard";

// Contract 2 & 3: DashboardEmptySurface gating formula + errored-insights behavior
//
// Tested through FirstLaunchDashboard, which owns the branch that mounts it.
// Uses the same mock harness as first-launch-dashboard.test.tsx.
//
// Production formula, delegated through resolveDashboardState:
//   analyticsLoaded = delivery.isSuccess && utilization.isSuccess && agents.isSuccess
//   sessionsKnown   = sessionsTotal > 0 || sessionsCountFresh
//   loading         = retrying || analyticsPending || sessions/import analyzing
//   empty           = !(loading || analyticsError || sessionsFailed || hasData)

const STUB_DASHBOARD_ROWS = vi.hoisted(() => [
  { tour: "stats" },
  { tour: "activity" },
  { tour: "models" },
  { tour: "prs" },
  { tour: "distribution" },
]);

// The row identities the shell compares `row.tour` against. Real values rather
// than stubs: this suite mocks `dashboard-tiles` for its ROW LIST, and a mock
// that drops the const would leave every comparison reading `undefined` and
// silently rendering neither branch.
const REAL_DASHBOARD_ROW_TOUR = vi.hoisted(() => ({
  Stats: "stats",
  Activity: "activity",
  Models: "models",
  AgentPipeline: "agent-pipeline",
  Autonomy: "autonomy",
  Frustration: "frustration",
  Prs: "prs",
  Distribution: "distribution",
}));

const hooks = vi.hoisted(() => ({
  DashboardRowContent: vi.fn(),
  Tour: vi.fn(),
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
}));

// ISS-5112: out of scope for the status-indicator contract, but the page now
// reads both. `useDesktopAuth` throws without its provider, and the harness row's
// local SQLite read wants a QueryClient — stub both at their signed-out, flag-off
// answers (the real behavior lives in guest-tour-account-request.test.tsx). The
// status is assigned from the enum in `beforeEach`, not inside the factory: a
// `vi.mock` factory runs during the import phase, before this file's own imports
// are initialized.
const authStatus = vi.hoisted(() => ({ value: "" as string }));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: {
      status: authStatus.value,
      userId: null,
      organizationId: null,
    },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));
// ISS-6002: this suite's subject is the gating formula, not the readiness probe
// (which reaches the local agent-monitor over IPC). Stub ONLY that hook so the
// real `resolveDashboardState` under test still runs.
vi.mock("../dashboard-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-state")>()),
  useDashboardSessionSource: () => ({
    ready: true,
    importInProgress: false,
    unavailable: false,
  }),
  // ISS-6002 (review): a zero only counts once a read has landed WITH the
  // store up. This suite drives a single static query fixture, so stub the
  // freshness verdict too — it is subject-tested in dashboard-state.test.ts.
  useSessionsCountFresh: () => true,
}));
vi.mock("@repo/app/insights/hooks/use-insights", () => ({
  insightsKeys: { all: ["insights"] },
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
// ISS-10486: the shell mounts the SLOT, which owns the card's ready/degraded/
// loading verdict over its own sections — so this is the seam to stub, and
// stubbing the card underneath it would leave the slot's real resolution
// running over a module that no longer exports what it reads.
vi.mock("@repo/app/insights/components/overview/ai-impact-slot", () => ({
  AiImpactSlot: () => null,
}));
// This contract test is about the status-indicator state machine, not the row
// catalog, so the stub returns a fixed row set. ISS-5061 re-gate: the shell now
// derives its order from `dashboardRowsFor`, so the stub supplies that too. The
// stub row set contains no `agent-pipeline` row, so the gate is a no-op here and
// this file stays out of the gate's business.
vi.mock("@repo/app/insights/components/overview/dashboard-tiles", () => ({
  DASHBOARD_ROWS: STUB_DASHBOARD_ROWS,
  // The shell compares `row.tour` against these, so a partial mock that omits
  // the const leaves every comparison reading `undefined` rather than failing.
  // Real values, not stubs — the comparisons are against the live vocabulary.
  DashboardRowTour: REAL_DASHBOARD_ROW_TOUR,
  dashboardRowsFor: () => STUB_DASHBOARD_ROWS,
}));
vi.mock("@repo/app/insights/lib/tile-availability", () => ({
  resolveMissingSourceTileAvailability: vi.fn(),
}));
vi.mock("@repo/app/shared/feature-flags/feature-flagged", () => ({
  FeatureFlagged: () => null,
}));
vi.mock("@repo/app/insights/components/overview/dashboard-rows", () => ({
  DashboardRowContent: (props: { row: { tour: string } }) => {
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
  DashboardLoading: () => <div data-testid="dashboard-loading" />,
}));
vi.mock(
  "@repo/app/onboarding/components/dashboard-tour/dashboard-tour",
  () => ({
    Tour: (props: { active: boolean }) => {
      hooks.Tour(props);
      return null;
    },
  })
);
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
    isSuccess: boolean;
    isError: boolean;
    dataUpdatedAt: number;
  }> = {}
) {
  return {
    data: { total: 0, items: [] },
    isLoading: false,
    // ISS-6002: the empty/ready decision now reads the session query's own
    // status. A resolved mock reports `isSuccess`; a zero total WITHOUT one is
    // the "still loading" case the page must no longer render as empty.
    isSuccess: true,
    isError: false,
    dataUpdatedAt: 1,
    ...overrides,
  };
}

function insightResult(
  overrides: Partial<{
    isSuccess: boolean;
    isLoading: boolean;
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

function renderDashboard(sourceOverrides: Partial<InsightsDataSource> = {}) {
  const source: InsightsDataSource = {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getAgents: vi.fn(),
    getDelivery: vi.fn(),
    getUtilization: vi.fn(),
    ...sourceOverrides,
  };
  return render(<FirstLaunchDashboard />, {
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
}

beforeEach(() => {
  authStatus.value = DesktopAuthStatus.SignedOut;
});

// Contract 2: DashboardEmptySurface gating formula (FEA-2650)

describe("DashboardEmptySurface gating formula (FEA-2650)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.unstubAllGlobals();
  });

  // FEA-2650 + ISS-6002: pin the production state —
  //   loading = false because analytics and the session count are known
  //   empty   = true because there is no error, failed session read, or data
  // Live import status is false, so no local import work keeps the skeleton up.
  it("shows empty when analytics loaded + zero sessions + no active import", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard();

    expect(screen.getByText("No agent sessions yet")).toBeDefined();
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByTestId("dashboard-row")).toBeNull();
  });

  // FEA-2650: pin that when analytics are still loading, the loading skeleton
  // shows even with zero sessions — never the misleading "No agent sessions
  // yet" message while data may still be arriving.
  // Formula: analyticsLoaded=false → loading=true → empty=false
  it("shows loading skeleton — NOT the empty state — while analytics are still loading with zero sessions", () => {
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false, isLoading: true })
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
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard();

    expect(screen.getByTestId("dashboard-loading")).toBeDefined();
    expect(screen.queryByText("No agent sessions yet")).toBeNull();
  });

  // FEA-2650: pin that with data present, neither loading nor empty renders —
  // the dashboard rows appear.
  // Formula: analyticsLoaded=true, hasData=true
  //   loading = false, empty = !(false || true) = false → rows render
  it("renders dashboard rows — neither loading nor empty — when analytics loaded with sessions", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 3, items: [] } })
    );

    renderDashboard();

    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByText("No agent sessions yet")).toBeNull();
    expect(screen.getAllByTestId("dashboard-row").length).toBeGreaterThan(0);
  });
});

// Contract 3: Errored insights section behavior (FEA-3240)
//
// Production formula: analyticsError = delivery.isError || utilization.isError || agents.isError
// When any insights query terminally errors, the dashboard stops the loading
// skeleton and renders a degraded/error state with a Retry button. Clicking
// Retry invalidates all insights queries and shows normal loading treatment
// until all three settle. If all three succeed on retry, the dashboard renders.

const queryClientMocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: queryClientMocks.invalidateQueries,
    }),
  };
});

// PLN-1875 Step 9: the page now reads the guided-onboarding run to reconcile the
// two tour-seen records. The real `useGuidedDashboardTour` stays in the render
// path; only its API client, auth adapter and QueryClient are stubbed out.
vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", async () => {
  const { guidedOnboardingStubModule } = await import(
    "./guided-onboarding-stub"
  );
  return guidedOnboardingStubModule();
});
const RETRY_NAME_PATTERN = /retry/i;

describe("Errored insights section — error state and retry (FEA-3240)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.unstubAllGlobals();
  });

  // FEA-3240: when one insights query errors, the dashboard shows a degraded
  // state with a clear message and a Retry button — NOT the loading skeleton.
  it("shows error state with Retry button when one insights section errors", () => {
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false, isError: true, isFetching: false })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { charts: {} },
        isFetching: false,
      })
    );
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { kpis: [], charts: { modelBreakdown: [] } },
        isFetching: false,
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    expect(
      screen.getByText("Dashboard metrics are temporarily unavailable.")
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: RETRY_NAME_PATTERN })
    ).toBeDefined();
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByTestId("dashboard-row")).toBeNull();
  });

  // FEA-3240: clicking Retry invalidates insights queries and shows loading.
  it("shows loading treatment after Retry is clicked", () => {
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false, isError: true, isFetching: false })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { charts: {} },
        isFetching: false,
      })
    );
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { kpis: [], charts: { modelBreakdown: [] } },
        isFetching: false,
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    const { rerender } = renderDashboard();

    const retryBtn = screen.getByRole("button", { name: RETRY_NAME_PATTERN });
    act(() => {
      retryBtn.click();
    });

    expect(queryClientMocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["insights"],
    });

    // Simulate fetching state after invalidation.
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false, isError: false, isFetching: true })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({ isSuccess: false, isError: false, isFetching: true })
    );
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({ isSuccess: false, isError: false, isFetching: true })
    );

    // `rerender` re-wraps its argument in the SAME wrapper `renderDashboard`
    // installed, so re-passing the providers here would nest a second copy and
    // REMOUNT `FirstLaunchDashboard` — discarding the `retrying` state this case
    // exists to observe. Rerender the bare element so the instance survives.
    act(() => {
      rerender(<FirstLaunchDashboard />);
    });

    expect(screen.getByTestId("dashboard-loading")).toBeDefined();
    expect(
      screen.queryByText("Dashboard metrics are temporarily unavailable.")
    ).toBeNull();
  });

  // FEA-3240: after a successful retry, the dashboard renders normally.
  it("restores dashboard when retry succeeds", () => {
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false, isError: true, isFetching: false })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { charts: {} },
        isFetching: false,
      })
    );
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { kpis: [], charts: { modelBreakdown: [] } },
        isFetching: false,
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    const { rerender } = renderDashboard();

    act(() => {
      screen.getByRole("button", { name: RETRY_NAME_PATTERN }).click();
    });

    // Simulate successful refetch completion.
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: true, data: {}, isFetching: false })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { charts: {} },
        isFetching: false,
      })
    );
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { kpis: [], charts: { modelBreakdown: [] } },
        isFetching: false,
      })
    );

    act(() => {
      rerender(
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <InsightsDataSourceProvider
            value={{
              availableScopes: [InsightsScope.Me],
              availableSections: [
                InsightsSection.Delivery,
                InsightsSection.Utilization,
                InsightsSection.Agents,
              ],
              getAgents: vi.fn(),
              getDelivery: vi.fn(),
              getUtilization: vi.fn(),
            }}
          >
            <FirstLaunchDashboard />
          </InsightsDataSourceProvider>
        </FeatureFlagAdapterProvider>
      );
    });

    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(
      screen.queryByText("Dashboard metrics are temporarily unavailable.")
    ).toBeNull();
    expect(screen.getAllByTestId("dashboard-row").length).toBeGreaterThan(0);
  });

  // FEA-3240: the retrying state masks the error while refetch is in flight
  // even when the errored query still reports isError=true (React Query keeps
  // the error state until the refetch succeeds).
  it("masks error state during retry when query is still isError + isFetching", () => {
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false, isError: true, isFetching: true })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { charts: {} },
        isFetching: true,
      })
    );
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { kpis: [], charts: { modelBreakdown: [] } },
        isFetching: true,
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    // Error state shows because retrying hasn't been set yet (no click).
    expect(
      screen.getByText("Dashboard metrics are temporarily unavailable.")
    ).toBeDefined();

    // Click Retry — retrying flips to true, masking the error.
    act(() => {
      screen.getByRole("button", { name: RETRY_NAME_PATTERN }).click();
    });

    // Now retrying=true → loading=true → shows loading, not error.
    expect(screen.getByTestId("dashboard-loading")).toBeDefined();
    expect(
      screen.queryByText("Dashboard metrics are temporarily unavailable.")
    ).toBeNull();
  });
});
