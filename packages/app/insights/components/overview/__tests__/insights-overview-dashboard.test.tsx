import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { SessionSortKey } from "@repo/app/agents/lib/session-sort-group";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_IMPACT_FEATURE_FLAG_KEY } from "../ai-impact-card";
import { InsightsOverviewDashboard } from "../insights-overview-dashboard";

// Mock the data hooks so we drive query states directly, and stub the heavy
// row renderer / sessions table so the test targets the body's orchestration
// (loading / error / empty / which rows are visible) rather than chart render.
const hooks = vi.hoisted(() => ({
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useAgentSessions: vi.fn(),
}));

vi.mock("@repo/app/insights/hooks/use-insights", () => ({
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));

vi.mock("../dashboard-rows", () => ({
  DashboardRowContent: ({
    row,
    deltaLabel,
    getTileAvailability,
    periodLabel,
  }: {
    row: { tour: string };
    deltaLabel?: string;
    getTileAvailability?: unknown;
    periodLabel?: string;
  }) => (
    <div
      data-delta-label={deltaLabel}
      data-has-availability={typeof getTileAvailability === "function"}
      data-period-label={periodLabel}
      data-testid={`row-${row.tour}`}
    />
  ),
}));

vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
}));

const succeeded = (data: unknown) => ({
  isSuccess: true,
  isError: false,
  isLoading: false,
  data,
});
const pending = () => ({
  isSuccess: false,
  isError: false,
  isLoading: true,
  data: undefined,
});
const errored = () => ({
  isSuccess: false,
  isError: true,
  isLoading: false,
  data: undefined,
});

const DEGRADED_RE = /temporarily unavailable/i;
const NO_SESSIONS_RE = /no agent sessions yet/i;

const emptySeries = { series: [], points: [] };
// Cloud Insights API today: no activityHeatmap, no autonomyTrend.
const webUtilization = { kpis: [], charts: { eventActivity: emptySeries } };
const webAgents = {
  kpis: [],
  charts: { modelUsageOverTime: emptySeries, modelBreakdown: [] },
};
const webDelivery = { kpis: [], charts: {} };

function sessions(total: number) {
  return succeeded({
    total,
    items: Array.from({ length: Math.min(total, 1) }, (_, i) => ({
      id: `s${i}`,
    })),
  });
}

function setInsights(state: {
  delivery?: ReturnType<typeof succeeded>;
  utilization?: ReturnType<typeof succeeded>;
  agents?: ReturnType<typeof succeeded>;
}) {
  hooks.useDeliveryInsights.mockReturnValue(
    state.delivery ?? succeeded(webDelivery)
  );
  hooks.useUtilizationInsights.mockReturnValue(
    state.utilization ?? succeeded(webUtilization)
  );
  hooks.useAgentsInsights.mockReturnValue(state.agents ?? succeeded(webAgents));
}

// The AI Impact card is gated behind the `emergent` flag, so the dashboard now
// requires a feature-flag adapter ancestor; default to no flags enabled so the
// gated slice stays dark (matching production until the flag is turned on).
const renderDashboard = (enabledFlags: string[] = [], theme?: A11yTheme) => {
  const dashboard = (
    <InsightsDataSourceProvider value={createInsightsDataSource()}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <InsightsOverviewDashboard getSessionHref={() => "/x"} />
      </FeatureFlagAdapterProvider>
    </InsightsDataSourceProvider>
  );

  if (theme) {
    return render(<A11yThemeRoot theme={theme}>{dashboard}</A11yThemeRoot>);
  }

  return render(dashboard);
};

const renderDashboardForA11y = (theme: A11yTheme) =>
  render(
    <A11yThemeRoot theme={theme}>
      <InsightsDataSourceProvider value={createInsightsDataSource()}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <InsightsOverviewDashboard getSessionHref={() => "/x"} />
        </FeatureFlagAdapterProvider>
      </InsightsDataSourceProvider>
    </A11yThemeRoot>
  );

const AI_IMPACT_RE = /ai impact/i;

// Period the insights queries were last driven with (all three share it).
const lastPeriod = () => hooks.useDeliveryInsights.mock.calls.at(-1)?.[0];

describe("InsightsOverviewDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The picker persists per-surface to localStorage; reset so each test
    // starts from the 90d default rather than a sibling test's selection.
    localStorage.clear();
  });

  it("shows a degraded state (not a perpetual skeleton) when an insights query errors", () => {
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    expect(screen.getByText(DEGRADED_RE)).toBeInTheDocument();
    expect(screen.queryByTestId("row-stats")).not.toBeInTheDocument();
  });

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps dashboard critical a11y and contrast clean in %s theme", async (theme) => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    const { container } = renderDashboardForA11y(theme);

    await expectCriticalAxeClean(container);
    expectElementContrast(screen.getByText("Recent Sessions"), {
      background: themeBackground(theme),
      label: `dashboard recent sessions ${theme}`,
    });
  });

  it("does not flash the empty state while the sessions query is still loading", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(pending());

    renderDashboard();

    // Insights resolved but sessions are still in flight: render the dashboard,
    // never the "no sessions" empty state.
    expect(screen.queryByText(NO_SESSIONS_RE)).not.toBeInTheDocument();
    expect(screen.getByTestId("row-stats")).toBeInTheDocument();
  });

  it("loads Recent Sessions with the Sessions page default activity window", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();

    expect(hooks.useAgentSessions).toHaveBeenCalledWith({
      limit: 8,
      startDate: expect.any(String),
      sortBy: SessionSortKey.LastActivity,
      sortDir: "desc",
    });
  });

  it("shows the empty state only once analytics and sessions resolve with no sessions", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(0));

    renderDashboard();

    expect(screen.getByText(NO_SESSIONS_RE)).toBeInTheDocument();
  });

  it("omits the desktop-only heatmap and autonomy rows when the API does not serve them", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();

    expect(screen.getByTestId("row-stats")).toBeInTheDocument();
    expect(screen.getByTestId("row-models")).toBeInTheDocument();
    expect(screen.getByTestId("row-prs")).toBeInTheDocument();
    expect(screen.getByTestId("row-distribution")).toBeInTheDocument();
    expect(screen.queryByTestId("row-activity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("row-autonomy")).not.toBeInTheDocument();
    // Recent Sessions still renders (re-anchored under the stats row).
    expect(screen.getByText("Recent Sessions")).toBeInTheDocument();
  });

  it("passes tile availability wiring to overview rows", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();

    expect(screen.getByTestId("row-stats")).toHaveAttribute(
      "data-has-availability",
      "true"
    );
  });

  it("renders the heatmap and autonomy rows when their data is present", () => {
    setInsights({
      utilization: succeeded({
        kpis: [],
        charts: {
          eventActivity: emptySeries,
          activityHeatmap: { days: [], cells: [] },
        },
      }),
      agents: succeeded({
        kpis: [],
        charts: {
          modelUsageOverTime: emptySeries,
          modelBreakdown: [],
          autonomyTrend: emptySeries,
        },
      }),
    });
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();

    expect(screen.getByTestId("row-activity")).toBeInTheDocument();
    expect(screen.getByTestId("row-autonomy")).toBeInTheDocument();
  });

  it("keeps the AI Impact card dark when the emergent flag is off", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();

    expect(screen.getByTestId("row-stats")).toBeInTheDocument();
    expect(screen.queryByText(AI_IMPACT_RE)).not.toBeInTheDocument();
  });

  it("renders the AI Impact card after the headline row when emergent is on", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard([AI_IMPACT_FEATURE_FLAG_KEY]);

    expect(screen.getByText(AI_IMPACT_RE)).toBeInTheDocument();
  });

  it("defaults to the 90d window and labels KPI deltas QoQ", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();

    // Default range (FEA-2232 Q-003) maps to the "90" InsightsPeriod...
    expect(lastPeriod()).toBe("90");
    // ...and the quarter-over-quarter delta caption flows to the tiles.
    expect(screen.getByTestId("row-stats")).toHaveAttribute(
      "data-delta-label",
      "QoQ"
    );
    expect(screen.getByLabelText("Last 7 days")).toBeInTheDocument();
  });

  it("re-drives the insights period and delta label when the picker changes", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();
    expect(lastPeriod()).toBe("90");

    // Switch to the 7-day window via the shared DateRangeFilter.
    fireEvent.click(screen.getByLabelText("Last 7 days"));

    expect(lastPeriod()).toBe("7");
    expect(screen.getByTestId("row-stats")).toHaveAttribute(
      "data-delta-label",
      "WoW"
    );
  });
});

function createInsightsDataSource(): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getTileAvailability: () => ({ state: BranchKpiState.Available }),
    getDelivery: () => Promise.reject(new Error("mocked by hook")),
    getUtilization: () => Promise.reject(new Error("mocked by hook")),
    getAgents: () => Promise.reject(new Error("mocked by hook")),
  };
}
