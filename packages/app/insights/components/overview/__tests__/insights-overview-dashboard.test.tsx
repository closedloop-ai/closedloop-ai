import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { SessionSortKey } from "@repo/app/agents/lib/session-sort-group";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFRESHING_ONSET_MS } from "../dashboard-refreshing";
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
  isFetching: false,
  data,
});
// FEA-4020: settled-success but re-fetching over the already-present data (the
// range-change / manual-refresh case). `keepPreviousData` keeps `data` and
// `isSuccess`, so only `isFetching` flips.
const refetching = (data: unknown) => ({
  isSuccess: true,
  isError: false,
  isLoading: false,
  isFetching: true,
  data,
});
const pending = () => ({
  isSuccess: false,
  isError: false,
  isLoading: true,
  isFetching: true,
  data: undefined,
});
const errored = () => ({
  isSuccess: false,
  isError: true,
  isLoading: false,
  isFetching: false,
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
// An org that actually runs subagents: the Agents section resolves WITH a
// populated collaboration graph, which is what keeps the agent-pipeline row on
// the dashboard now that ISS-5280 retired its flag.
const webAgentsWithPipeline = {
  ...webAgents,
  charts: {
    ...webAgents.charts,
    agentPipeline: {
      nodes: [{ id: "researcher", label: "researcher", value: 4 }],
      edges: [],
    },
  },
};

function sessions(total: number) {
  return succeeded({
    total,
    items: Array.from({ length: Math.min(total, 1) }, (_, i) => ({
      id: `s${i}`,
    })),
  });
}

// FEA-4020: a settled sessions query that is re-fetching over its prior data.
function refetchingSessions(total: number) {
  return {
    ...sessions(total),
    isFetching: true,
  };
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

// The dashboard reads other feature flags via `useFeatureFlagEnabled`, so it
// requires a feature-flag adapter ancestor; default to no flags enabled. The AI
// Impact card is no longer gated (FEA-4000 graduated it) — it renders regardless
// of `enabledFlags`.
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
// FEA-4020: the single header "Refreshing" indicator's copy.
const REFRESHING_RE = /refreshing/i;

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
      // FEA-3534: the dashboard defaults to the Me scope, which threads
      // viewerScope=self into the Recent Sessions read so the card stays
      // scoped to the authenticated user instead of the whole org.
      viewerScope: AgentSessionViewerScope.Self,
    });
  });

  it("shows the empty state only once analytics and sessions resolve with no sessions", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(0));

    renderDashboard();

    expect(screen.getByText(NO_SESSIONS_RE)).toBeInTheDocument();
  });

  it("surfaces the recent-sessions error fallback inside the ready state when the session feed errors", () => {
    setInsights({});
    // Analytics succeeded but the sessions refetch errored (e.g. transient network
    // failure after initial load). The dashboard must still render the row body —
    // the sessions card shows the error fallback, not the outer empty state.
    hooks.useAgentSessions.mockReturnValue(errored());

    renderDashboard();

    expect(screen.getByText(DEGRADED_RE)).toBeInTheDocument();
    // The row layout is intact (analytics are fine).
    expect(screen.getByTestId("row-stats")).toBeInTheDocument();
    // SyncedSessionsTable is suppressed — only the error text renders.
    expect(
      screen.queryByTestId("synced-sessions-table")
    ).not.toBeInTheDocument();
    // The outer "no sessions yet" empty state must NOT show (sessions may exist
    // from a prior successful fetch; isSuccess is false so empty stays false).
    expect(screen.queryByText(NO_SESSIONS_RE)).not.toBeInTheDocument();
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

  // ISS-5061 re-gate (reverses ISS-5280 for this one flag): closed-by-default on
  // web. Rendered with NO flags enabled and WITH a populated graph, so the
  // absence can only come from the PostHog gate and not from the absent-data
  // filter covered below.
  it("omits the agent-collaboration row when the flag is off", () => {
    setInsights({ agents: succeeded(webAgentsWithPipeline) });
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();

    // The whole slot is absent — no card, no skeleton, no grid slot.
    expect(document.querySelector('[data-tour="agent-pipeline"]')).toBeNull();
    expect(screen.queryByTestId("row-agent-pipeline")).not.toBeInTheDocument();
    // Its neighbours still render, so the rows below close up rather than the
    // dashboard failing to mount.
    expect(screen.getByTestId("row-models")).toBeInTheDocument();
    expect(screen.getByTestId("row-prs")).toBeInTheDocument();
  });

  // Gate-ON counterpart. Identical data to the test above, so the ONLY
  // difference is the seeded flag — this pair cannot both pass without the gate.
  it("renders the agent-collaboration row when the flag is on", () => {
    setInsights({ agents: succeeded(webAgentsWithPipeline) });
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard([AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    expect(screen.getByTestId("row-agent-pipeline")).toBeInTheDocument();
    expect(
      document.querySelector('[data-tour="agent-pipeline"]')
    ).not.toBeNull();
    expect(screen.getByTestId("row-models")).toBeInTheDocument();
    expect(screen.getByTestId("row-prs")).toBeInTheDocument();
  });

  // The gate is not the only reason this row can disappear: an org that runs no
  // subagents resolves the Agents section without pipeline nodes, and the row
  // drops out exactly like autonomy does. Driven with the flag ON so this covers
  // the absent-data filter rather than passing for the gate's reason.
  it("drops the agent-collaboration row once Agents resolves without nodes", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard([AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    // The whole slot is gone — not merely its body — so this is the filter
    // dropping the row, not a skeleton standing in for a still-loading section.
    expect(document.querySelector('[data-tour="agent-pipeline"]')).toBeNull();
    expect(screen.queryByTestId("row-agent-pipeline")).not.toBeInTheDocument();
    // Rowmates that do not depend on pipeline data are untouched, so this is a
    // targeted drop rather than the Agents section failing wholesale.
    expect(screen.getByTestId("row-models")).toBeInTheDocument();
    expect(screen.getByTestId("row-prs")).toBeInTheDocument();
  });

  // The row is KEPT while Agents is still loading, so the layout does not
  // reflow when the nodes land — the same contract the autonomy row has. While
  // loading the slot renders its skeleton rather than the row body, so this
  // asserts the `data-tour` slot survived the filter, not the mocked content.
  it("keeps the agent-collaboration row slot while the Agents section loads", () => {
    setInsights({ agents: pending() });
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard([AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    expect(
      document.querySelector('[data-tour="agent-pipeline"]')
    ).not.toBeNull();
    // Proving it is the loading branch, not the resolved one.
    expect(screen.queryByTestId("row-agent-pipeline")).not.toBeInTheDocument();
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

  it("renders the AI Impact card after the headline row for everyone (FEA-4000 graduated)", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    // FEA-4000 removed the `ai-impact-card` flag gate, so the card renders with
    // no flag enabled — the empty `enabledFlags` default proves it is no longer
    // gated (this assertion would fail under the old off-branch).
    renderDashboard();

    expect(screen.getByTestId("row-stats")).toBeInTheDocument();
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

  // Per-section loading treatment (fix for the "dashboard hangs before it loads"
  // report): the shell + date picker paint immediately and every row shows its
  // own design-system Skeleton until the sections it reads from resolve, instead
  // of one all-or-nothing gate holding the whole page behind the slowest query.
  describe("per-section loading treatment", () => {
    // The design-system Skeleton primitive tags itself data-slot="skeleton".
    const skeletons = (container: HTMLElement) =>
      container.querySelectorAll('[data-slot="skeleton"]');

    it("paints the shell with skeleton rows (not a blank page) while every section loads", () => {
      setInsights({
        delivery: pending(),
        utilization: pending(),
        agents: pending(),
      });
      hooks.useAgentSessions.mockReturnValue(pending());

      const { container } = renderDashboard();

      // The chrome is up immediately — the date-range picker is interactive, so
      // the page never reads as a frozen shell.
      expect(screen.getByLabelText("Last 7 days")).toBeInTheDocument();
      // Skeleton placeholders stand in for the rows...
      expect(skeletons(container).length).toBeGreaterThan(0);
      // ...and the real row content has NOT rendered yet.
      expect(screen.queryByTestId("row-stats")).not.toBeInTheDocument();
      expect(screen.queryByTestId("row-models")).not.toBeInTheDocument();
      expect(screen.queryByTestId("row-prs")).not.toBeInTheDocument();
      // No all-or-nothing full-page spinner; no premature empty/degraded state.
      expect(screen.queryByText(NO_SESSIONS_RE)).not.toBeInTheDocument();
      expect(screen.queryByText(DEGRADED_RE)).not.toBeInTheDocument();
    });

    it("resolves each section independently: a slow section skeletons only its own rows", () => {
      // Delivery + Utilization landed (stats/prs ready); the agents section is
      // still in flight, so only the agents-backed rows (models / distribution)
      // stay as skeletons. A slow query no longer blocks the whole page.
      setInsights({
        delivery: succeeded(webDelivery),
        utilization: succeeded(webUtilization),
        agents: pending(),
      });
      hooks.useAgentSessions.mockReturnValue(sessions(3));

      const { container } = renderDashboard();

      // Delivery/Utilization-backed rows have swapped to real content.
      expect(screen.getByTestId("row-stats")).toBeInTheDocument();
      expect(screen.getByTestId("row-prs")).toBeInTheDocument();
      // Agents-backed rows are still skeletons (no real content yet).
      expect(screen.queryByTestId("row-models")).not.toBeInTheDocument();
      expect(screen.queryByTestId("row-distribution")).not.toBeInTheDocument();
      // Some skeletons are still on screen for the pending section's rows.
      expect(skeletons(container).length).toBeGreaterThan(0);
    });

    it("swaps every skeleton for content once all sections resolve", () => {
      setInsights({});
      hooks.useAgentSessions.mockReturnValue(sessions(3));

      const { container } = renderDashboard();

      // Every web-visible row now renders real content...
      expect(screen.getByTestId("row-stats")).toBeInTheDocument();
      expect(screen.getByTestId("row-models")).toBeInTheDocument();
      expect(screen.getByTestId("row-prs")).toBeInTheDocument();
      expect(screen.getByTestId("row-distribution")).toBeInTheDocument();
      // ...and no dashboard-row skeletons remain (the swap is complete).
      expect(skeletons(container).length).toBe(0);
    });
  });

  // FEA-4020: the dashboard has ONE range/scope selection driving every section
  // query, so a change refetches them all at once. Rather than dim every row and
  // float a spinner over each, the whole dashboard carries a SINGLE header
  // "Refreshing" indicator, gated on the user-driven request key changing (not
  // raw `isFetching`), debounced with an onset delay so a warm-cache refetch
  // never flickers it, and never dimming the still-legible content.
  describe("single header refreshing indicator", () => {
    const skeletons = (container: HTMLElement) =>
      container.querySelectorAll('[data-slot="skeleton"]');

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    // Drives a real range change so the request key advances while every section
    // is refetching over its prior data — the exact user-driven refresh the
    // indicator is meant to signal. The refetching mocks are staged BEFORE the
    // click so the post-click re-render reads the in-flight state, then the onset
    // debounce is run out.
    const triggerUserRefresh = () => {
      setInsights({
        delivery: refetching(webDelivery),
        utilization: refetching(webUtilization),
        agents: refetching(webAgents),
      });
      hooks.useAgentSessions.mockReturnValue(refetchingSessions(3));
      act(() => {
        // Switch the range → new request key; the hook reads the staged
        // in-flight state on the resulting re-render.
        fireEvent.click(screen.getByLabelText("Last 7 days"));
      });
      act(() => {
        vi.advanceTimersByTime(REFRESHING_ONSET_MS + 50);
      });
    };

    it("shows one header 'Refreshing' indicator (never a skeleton, never dimmed content) on a user-driven range refresh", () => {
      setInsights({});
      hooks.useAgentSessions.mockReturnValue(sessions(3));

      const { container } = renderDashboard();
      // Settled first: no indicator, no dimming, content is up.
      expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
      expect(screen.getByTestId("row-stats")).toBeInTheDocument();

      triggerUserRefresh();

      // A single "Refreshing" indicator appears in the header...
      expect(screen.getAllByText(REFRESHING_RE)).toHaveLength(1);
      // ...content stays visible (no skeleton swap)...
      expect(screen.getByTestId("row-stats")).toBeInTheDocument();
      expect(skeletons(container).length).toBe(0);
      // ...and nothing is dimmed under an aria-busy overlay (the old per-row
      // treatment is gone — the refresh is signaled only in the header).
      expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(0);
    });

    it("does not flash the indicator for a background refetch at the SAME range/scope (poll / invalidation)", () => {
      setInsights({});
      hooks.useAgentSessions.mockReturnValue(sessions(3));

      const { rerender } = renderDashboard();

      // A refetch WITHOUT a range change (e.g. a poll tick or db invalidation):
      // isFetching flips true but the request key is unchanged.
      setInsights({
        delivery: refetching(webDelivery),
        utilization: refetching(webUtilization),
        agents: refetching(webAgents),
      });
      hooks.useAgentSessions.mockReturnValue(refetchingSessions(3));
      act(() => {
        rerender(
          <InsightsDataSourceProvider value={createInsightsDataSource()}>
            <FeatureFlagAdapterProvider
              adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
            >
              <InsightsOverviewDashboard getSessionHref={() => "/x"} />
            </FeatureFlagAdapterProvider>
          </InsightsDataSourceProvider>
        );
        vi.advanceTimersByTime(REFRESHING_ONSET_MS + 50);
      });

      expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
    });

    it("shows no indicator and no skeleton flicker once every section has settled", () => {
      setInsights({});
      hooks.useAgentSessions.mockReturnValue(sessions(3));

      const { container } = renderDashboard();
      act(() => {
        vi.advanceTimersByTime(REFRESHING_ONSET_MS + 50);
      });

      expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
      expect(skeletons(container).length).toBe(0);
    });

    it("keeps the first-load skeleton (never the refreshing indicator) while a section is on its first load", () => {
      // First load: pending() has no data — this must stay a skeleton, and the
      // header indicator must not show (it is gated on all sections settled).
      setInsights({
        delivery: succeeded(webDelivery),
        utilization: succeeded(webUtilization),
        agents: pending(),
      });
      hooks.useAgentSessions.mockReturnValue(sessions(3));

      const { container } = renderDashboard();
      act(() => {
        vi.advanceTimersByTime(REFRESHING_ONSET_MS + 50);
      });

      expect(screen.queryByTestId("row-models")).not.toBeInTheDocument();
      expect(skeletons(container).length).toBeGreaterThan(0);
      expect(screen.queryByText(REFRESHING_RE)).not.toBeInTheDocument();
    });
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
