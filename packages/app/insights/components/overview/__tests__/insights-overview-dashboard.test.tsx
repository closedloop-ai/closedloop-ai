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
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_DOWNLOAD_DESCRIPTION } from "../../../../onboarding/lib/desktop-download-copy";
import { REFRESHING_ONSET_MS } from "../dashboard-refreshing";
import { DashboardRowTour } from "../dashboard-tiles";
import {
  InsightsOverviewDashboard,
  RECENT_SESSIONS_DESCRIPTION,
} from "../insights-overview-dashboard";
import {
  DESKTOP_RECENT_SESSIONS_TITLE,
  DESKTOP_SYNCED_SESSIONS_TITLE,
  WEB_RECENT_SESSIONS_TITLE,
} from "../recent-sessions-copy";
import { withDashboardQueryClient } from "./dashboard-query-client";
import {
  ALL_ROW_DATA,
  expectedRowTours,
  NO_ROW_DATA,
  renderedRowTours,
} from "./dashboard-row-visibility-contract";
import {
  AI_IMPACT_RE,
  DEGRADED_RE,
  emptySeries,
  errored,
  NO_SESSIONS_RE,
  pending,
  refetching,
  refetchingSessions,
  SESSIONS_ERROR_RE,
  sessions,
  succeeded,
  webAgents,
  webAgentsWithPipeline,
  webDelivery,
  webUtilization,
} from "./dashboard-suite-fixtures";

// Mock the data hooks so we drive query states directly, and stub the heavy
// row renderer / sessions table so the test targets the body's orchestration
// (loading / error / empty / which rows are visible) rather than chart render.
const hooks = vi.hoisted(() => ({
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useAgentSessions: vi.fn(),
}));

// `importOriginal` so `insightsKeys` — the real query-key contract the retry
// invalidates against — survives the mock. A hand-written copy here would agree
// with itself if the production key ever changed.
vi.mock("@repo/app/insights/hooks/use-insights", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/app/insights/hooks/use-insights")
  >()),
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

/** The seven the caption promises, as the span the query must cover. */
const PINNED_WINDOW_DAYS = 7;
const SYNCED_WINDOW_RE = /always last 7 days.*synced agent runs/i;
const MS_PER_DAY = 86_400_000;

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
const renderDashboard = (
  enabledFlags: string[] = [],
  theme?: A11yTheme,
  queryClient?: QueryClient
) => {
  const dashboard = withDashboardQueryClient(
    <InsightsDataSourceProvider value={createInsightsDataSource()}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <InsightsOverviewDashboard
          emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
          getSessionHref={() => "/x"}
        />
      </FeatureFlagAdapterProvider>
    </InsightsDataSourceProvider>,
    queryClient
  );

  if (theme) {
    return render(<A11yThemeRoot theme={theme}>{dashboard}</A11yThemeRoot>);
  }

  return render(dashboard);
};

const renderDashboardForA11y = (theme: A11yTheme) =>
  render(
    withDashboardQueryClient(
      <A11yThemeRoot theme={theme}>
        <InsightsDataSourceProvider value={createInsightsDataSource()}>
          <FeatureFlagAdapterProvider
            adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
          >
            <InsightsOverviewDashboard
              emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
              getSessionHref={() => "/x"}
            />
          </FeatureFlagAdapterProvider>
        </InsightsDataSourceProvider>
      </A11yThemeRoot>
    )
  );

// FEA-4020: the single header "Refreshing" indicator's copy.
const REFRESHING_RE = /refreshing/i;

// Period the insights queries were last driven with (all three share it).
const lastPeriod = () => hooks.useDeliveryInsights.mock.calls.at(-1)?.[0];
describe("InsightsOverviewDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The picker persists per-surface to localStorage; reset so each test
    // starts from the shared 7d default rather than a sibling test's selection.
    localStorage.clear();
  });

  it.each([A11yTheme.Light, A11yTheme.Dark])(
    "keeps dashboard critical a11y and contrast clean in %s theme",
    async (theme) => {
      setInsights({});
      hooks.useAgentSessions.mockReturnValue(sessions(3));

      const { container } = renderDashboardForA11y(theme);

      await expectCriticalAxeClean(container);
      expectElementContrast(screen.getByText(WEB_RECENT_SESSIONS_TITLE), {
        background: themeBackground(theme),
        label: `dashboard recent sessions ${theme}`,
      });
    }
  );

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

    expect(hooks.useAgentSessions).toHaveBeenCalledWith(
      {
        limit: 8,
        startDate: expect.any(String),
        sortBy: SessionSortKey.LastActivity,
        sortDir: "desc",
        // FEA-3534: the dashboard defaults to the Me scope, which threads
        // viewerScope=self into the Recent Sessions read so the card stays
        // scoped to the authenticated user instead of the whole org.
        viewerScope: AgentSessionViewerScope.Self,
      },
      // ISS-7514: no feature-flag provider is mounted here, so the deferral
      // gate resolves closed and the read is issued on mount as before.
      { enabled: true }
    );
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

    expect(screen.getByText(SESSIONS_ERROR_RE)).toBeInTheDocument();
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
    expect(screen.getByText(WEB_RECENT_SESSIONS_TITLE)).toBeInTheDocument();
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

  // ISS-9993: this host decides which rows exist through the shared
  // `visibleDashboardRows` and nothing else. One fixture has none of the
  // data-conditional rows' data and one has all of it, so a row filtered here
  // by hand, or a row drawn here that the shared rule drops, fails. The desktop
  // suite runs the same contract against `FirstLaunchDashboard`.
  it.each([
    ["none", NO_ROW_DATA],
    ["all", ALL_ROW_DATA],
  ])(
    "renders exactly the rows the shared rule keeps when %s of the row data is present",
    (_label, payloads) => {
      setInsights({
        delivery: succeeded(payloads.delivery),
        utilization: succeeded(payloads.utilization),
        agents: succeeded(payloads.agents),
      });
      hooks.useAgentSessions.mockReturnValue(sessions(3));

      renderDashboard([AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

      expect(renderedRowTours(document)).toEqual(expectedRowTours(payloads));
    }
  );

  // Without this the pair above could pass on two fixtures the rule treats the
  // same, and prove nothing about the data-conditional rows.
  it("uses row-data fixtures the shared rule tells apart", () => {
    expect(expectedRowTours(NO_ROW_DATA)).toEqual([
      DashboardRowTour.Stats,
      DashboardRowTour.Models,
      DashboardRowTour.Prs,
      DashboardRowTour.Distribution,
    ]);
    expect(expectedRowTours(ALL_ROW_DATA)).toEqual([
      DashboardRowTour.Stats,
      DashboardRowTour.Activity,
      DashboardRowTour.Models,
      DashboardRowTour.AgentPipeline,
      DashboardRowTour.Autonomy,
      DashboardRowTour.Frustration,
      DashboardRowTour.Prs,
      DashboardRowTour.Distribution,
    ]);
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

  it("defaults to the 7d window and labels KPI deltas WoW", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();

    // The shared DEFAULT_DATE_RANGE (7d) maps to the "7" InsightsPeriod...
    expect(lastPeriod()).toBe("7");
    // ...and the week-over-week delta caption flows to the tiles.
    expect(screen.getByTestId("row-stats")).toHaveAttribute(
      "data-delta-label",
      "WoW"
    );
    expect(screen.getByLabelText("Last 90 days")).toBeInTheDocument();
  });

  it("re-drives the insights period and delta label when the picker changes", () => {
    setInsights({});
    hooks.useAgentSessions.mockReturnValue(sessions(3));

    renderDashboard();
    expect(lastPeriod()).toBe("7");

    // Switch to the 90-day window via the shared DateRangeFilter.
    fireEvent.click(screen.getByLabelText("Last 90 days"));

    expect(lastPeriod()).toBe("90");
    expect(screen.getByTestId("row-stats")).toHaveAttribute(
      "data-delta-label",
      "QoQ"
    );
  });

  /**
   * tamsinb (#5505): the clock is pinned in beforeEach/afterEach rather than
   * inline, matching the refreshing-indicator block below. An inline
   * `vi.useFakeTimers()` that relies on reaching `vi.useRealTimers()` at the
   * bottom leaks a frozen clock into the next test whenever an assertion between
   * the two throws — so a failure here would surface as an unrelated sibling
   * failing on a date it never set.
   *
   * Mid-May deliberately: `getStartIsoForDays` walks back with local-time
   * `setDate`, so a window straddling a DST transition would not be a whole
   * number of 24h days and the span identity would be off by an hour.
   */
  describe("Recent Sessions pinned window", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("discloses the Recent Sessions window and keeps it pinned when the picker moves", () => {
      // ISS-7185: every KPI above this card follows the range picker; the card
      // does not. Both halves are asserted together, because the disclosure is
      // only worth anything if the pin is real — a card that quietly started
      // following the picker would still pass an assertion on the caption alone.
      setInsights({});
      hooks.useAgentSessions.mockReturnValue(sessions(3));

      renderDashboard();
      expect(lastPeriod()).toBe("7");
      expect(screen.getByText(WEB_RECENT_SESSIONS_TITLE)).toBeVisible();
      // The desktop counterpart positively asserts this same canonical title.
      expect(screen.queryByText(DESKTOP_RECENT_SESSIONS_TITLE)).toBeNull();
      expect(screen.queryByText(DESKTOP_SYNCED_SESSIONS_TITLE)).toBeNull();
      expect(screen.getByText(RECENT_SESSIONS_DESCRIPTION)).toHaveTextContent(
        SYNCED_WINDOW_RE
      );

      fireEvent.click(screen.getByLabelText("Last 90 days"));

      // The tiles moved to the 90-day cohort...
      expect(lastPeriod()).toBe("90");
      // ...and the card still reads its own 7-day window.
      //
      // Note what the set-size below does and does not prove (review, #5505):
      // `startDate` is `useMemo(..., [])`, so size-1 is guaranteed by the memo,
      // not by the pin — the card does not re-query at all. It catches the
      // realistic regression (deriving the bound from `dateRange`, which changes
      // the deps and the value) but would not catch one that kept empty deps.
      // The span identity below is the assertion carrying the real weight.
      expect(screen.getByText(RECENT_SESSIONS_DESCRIPTION)).toBeInTheDocument();
      // ISS-9727 review: this dashboard now makes TWO session reads, and only
      // one of them is this card's. The other is the all-time existence read,
      // which is deliberately UNBOUNDED — so it contributes an `undefined`
      // `startDate` that has nothing to do with the pin under test. The reads
      // are told apart by the count-only hint that only the all-time one
      // carries, never by the field being asserted, so a pin that genuinely
      // regressed to an unbounded query still fails here.
      const startDates = new Set(
        hooks.useAgentSessions.mock.calls
          .filter((call) => call[0]?.countOnly !== true)
          .map((call) => call[0]?.startDate)
      );
      expect(startDates.size).toBe(1);
      // whitlockk (#5505): stability alone is not the claim. An arbitrary frozen date
      // would satisfy the set-size check while the caption promised seven days, so
      // assert the window the card actually QUERIES is the one it ADVERTISES —
      // measured against the pinned clock, so this is a fixed arithmetic identity
      // and not a real-clock timing assertion.
      const [queriedStart] = [...startDates];
      expect(Date.now() - Date.parse(queriedStart as string)).toBe(
        PINNED_WINDOW_DAYS * MS_PER_DAY
      );
    });
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
        fireEvent.click(screen.getByLabelText("Last 90 days"));
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

      // One client across both renders, so the rerender below changes only the
      // query statuses under test.
      const queryClient = createTestQueryClient();
      const { rerender } = renderDashboard([], undefined, queryClient);

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
          withDashboardQueryClient(
            <InsightsDataSourceProvider value={createInsightsDataSource()}>
              <FeatureFlagAdapterProvider
                adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
              >
                <InsightsOverviewDashboard
                  emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
                  getSessionHref={() => "/x"}
                />
              </FeatureFlagAdapterProvider>
            </InsightsDataSourceProvider>,
            queryClient
          )
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
