// ISS-10651 — the dashboard stays visible and keeps updating while a local
// import runs behind the non-dismissible guided-onboarding takeover.
//
// A SEQUENCE suite, deliberately. The defect is not a wrong final state: it is
// that a POPULATED page was replaced by a skeleton for the whole import, so
// every case here drives at least two renders and asserts what happened between
// them. One end-state assertion cannot tell a page that revealed and held from
// a page that revealed, reverted, and revealed again.

import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import type { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { FirstLaunchDashboard } from "../first-launch-dashboard";

type RowProps = { heatmap?: unknown; row: { tour: string } };
type TourProps = Parameters<typeof Tour>[0];

const hooks = vi.hoisted(() => ({
  DashboardRowContent: vi.fn<(props: RowProps) => void>(),
  Tour: vi.fn<(props: TourProps) => void>(),
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  sessionSource: {
    value: { ready: true, importInProgress: false, unavailable: false },
  },
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: {
      status: DesktopAuthStatus.SignedOut,
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
// Only the IPC-backed readiness probe is stubbed. The real `useDashboardState`
// — the flag read and the fold this suite is about — stays in the render path.
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
    useQueryClient: () => ({
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    }),
  };
});
vi.mock("@repo/app/insights/hooks/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    dateRange: "30d",
    setDateRange: vi.fn(),
    period: "30d",
    periodLabel: "Last 30 days",
    deltaLabel: "vs. prior 30 days",
  }),
}));
vi.mock("@repo/app/insights/components/overview/dashboard-rows", () => ({
  DashboardRowContent: (props: RowProps) => {
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
    Tour: (props: TourProps) => {
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
vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", async () => {
  const { guidedOnboardingStubModule } = await import(
    "./guided-onboarding-stub"
  );
  return guidedOnboardingStubModule();
});

const AUTONOMY_TREND = { series: [], points: [] };

/** A heatmap carrying `cellCount` real parsed cells — never interpolated. */
function heatmapOf(cellCount: number) {
  return {
    days: ["Mon"],
    cells: Array.from({ length: cellCount }, (_, index) => ({
      day: "Mon",
      hour: index,
      value: index + 1,
    })),
  };
}

function insightResult(data: unknown) {
  return {
    isSuccess: true,
    isLoading: false,
    isError: false,
    isFetching: false,
    data,
  };
}

let pollAt = 1;

/**
 * Publish one poll's worth of state: the rows parsed so far, the heatmap built
 * from exactly those rows, and whether the import is still running.
 *
 * `dataUpdatedAt` advances on every call because the page distrusts a result
 * that predates the store proving it can serve rows (ISS-6002) — which is also
 * what makes a second call a genuinely NEW read rather than a re-render.
 */
function publishPoll({
  sessionsTotal,
  heatmapCells,
  importInProgress,
}: {
  sessionsTotal: number;
  heatmapCells: number;
  importInProgress: boolean;
}) {
  pollAt += 1;
  hooks.sessionSource.value = {
    ready: true,
    importInProgress,
    unavailable: false,
  };
  hooks.useAgentSessions.mockReturnValue({
    data: { total: sessionsTotal, items: [] },
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: pollAt,
  });
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ kpis: [], charts: {} })
  );
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({
      kpis: [],
      charts: { activityHeatmap: heatmapOf(heatmapCells) },
    })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({
      kpis: [],
      charts: {
        modelBreakdown: [],
        autonomyTrend: AUTONOMY_TREND,
        agentPipeline: {
          nodes: [{ id: "researcher", label: "researcher", value: 4 }],
          edges: [],
        },
      },
    })
  );
}

function insightsSource(): InsightsDataSource {
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
  };
}

function renderDashboard() {
  const result = render(<FirstLaunchDashboard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <InsightsDataSourceProvider value={insightsSource()}>
          {children}
        </InsightsDataSourceProvider>
      </FeatureFlagAdapterProvider>
    ),
  });
  // One more poll, as the real 2.5s backfill read does: the page refuses to
  // trust a result that landed before the store was proven up.
  act(() => {
    result.rerender(<FirstLaunchDashboard />);
  });
  return result;
}

/** The heatmap the rows were last handed. */
function renderedHeatmapCells(): number {
  const calls = hooks.DashboardRowContent.mock.calls;
  const last = calls.at(-1)?.[0].heatmap as { cells: unknown[] } | undefined;
  return last?.cells.length ?? -1;
}

describe("FirstLaunchDashboard during a running local import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pollAt = 1;
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reveals the partial dashboard and keeps updating it as more rows parse", () => {
    publishPoll({
      sessionsTotal: 12,
      heatmapCells: 1,
      importInProgress: true,
    });

    const { rerender } = renderDashboard();

    // Beat one: rows are in hand and the import is still running. The page
    // draws them.
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    const firstRow = screen.getAllByTestId("dashboard-row")[0];
    expect(renderedHeatmapCells()).toBe(1);
    // ISS-10492 moved progress to the shell; this dashboard owns the live rows.

    // Beat two: parsing continues and lands more real rows.
    publishPoll({
      sessionsTotal: 40,
      heatmapCells: 3,
      importInProgress: true,
    });
    act(() => {
      rerender(<FirstLaunchDashboard />);
    });

    expect(renderedHeatmapCells()).toBe(3);
    // Never back to the skeleton, and the same element carried through — the
    // page updated in place rather than tearing down and restarting.
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.getAllByTestId("dashboard-row")[0]).toBe(firstRow);
    // Nothing opened a tour over the takeover mid-import.
    for (const [props] of hooks.Tour.mock.calls) {
      expect(props.active).toBe(false);
    }
  });

  it("still shows the skeleton while an import has parsed nothing yet", () => {
    publishPoll({
      sessionsTotal: 0,
      heatmapCells: 0,
      importInProgress: true,
    });

    renderDashboard();

    // No rows to reveal, so the truthful screen is still the loading one — and
    // the empty verdict stays out of reach while the import is live.
    expect(screen.getByTestId("dashboard-loading")).toBeDefined();
    expect(screen.queryByText("No agent sessions yet")).toBeNull();
  });

  it("names the genuine empty install once an empty import settles", () => {
    publishPoll({
      sessionsTotal: 0,
      heatmapCells: 0,
      importInProgress: true,
    });
    const { rerender } = renderDashboard();

    publishPoll({
      sessionsTotal: 0,
      heatmapCells: 0,
      importInProgress: false,
    });
    act(() => {
      rerender(<FirstLaunchDashboard />);
    });

    expect(screen.getByText("No agent sessions yet")).toBeDefined();
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
  });
});
