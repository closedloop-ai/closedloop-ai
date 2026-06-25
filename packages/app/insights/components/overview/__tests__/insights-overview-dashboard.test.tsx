import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  DashboardRowContent: ({ row }: { row: { tour: string } }) => (
    <div data-testid={`row-${row.tour}`} />
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

const renderDashboard = () =>
  render(<InsightsOverviewDashboard getSessionHref={() => "/x"} />);

describe("InsightsOverviewDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a degraded state (not a perpetual skeleton) when an insights query errors", () => {
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    expect(screen.getByText(DEGRADED_RE)).toBeInTheDocument();
    expect(screen.queryByTestId("row-stats")).not.toBeInTheDocument();
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
});
