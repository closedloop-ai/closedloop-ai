import type {
  DeliveryInsightsResponse,
  TimeSeries,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  InsightsSection,
  KpiDeltaBasis,
  KpiFormat,
} from "@repo/api/src/types/insights";
import { mixedAgentSessionListFixtures } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { SESSIONS_GLANCEABLE_COLUMNS } from "@repo/app/agents/hooks/use-sessions-view-state";
import { makeTimeSeries } from "@repo/app/insights/components/insights-section-fixtures";
import { AiImpactCard } from "@repo/app/insights/components/overview/ai-impact-card";
import { DashboardCard } from "@repo/app/insights/components/overview/dashboard-card";
import { DashboardRowContent } from "@repo/app/insights/components/overview/dashboard-rows";
import {
  DASHBOARD_ROWS,
  type DashboardRow,
  type DashboardRowGates,
  DashboardRowTour,
} from "@repo/app/insights/components/overview/dashboard-tiles";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import type { DateRange } from "@repo/app/insights/lib/dashboard-range";
import { GROWTH_LABEL } from "@repo/app/insights/lib/dashboard-range";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { Clock3Icon } from "lucide-react";
import { AppScreenShell } from "./app-shell";

// Derived from the same canonical nav the shell renders, so the control can
// never offer a destination the product does not have.
const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

// The two rows this surface mounts, pulled from the SAME row order the real
// dashboard resolves through `dashboardRowsFor` rather than re-declared here,
// so a renamed or reordered row cannot silently drift the two apart.
const STATS_ROW = DASHBOARD_ROWS.find(
  (row) => row.tour === DashboardRowTour.Stats
) as DashboardRow;
const MODELS_ROW = DASHBOARD_ROWS.find(
  (row) => row.tour === DashboardRowTour.Models
) as DashboardRow;

// Neither row this surface renders is gated, so the gates object is a constant
// rather than the `useDashboardRowGates` hook the real page reads it from.
const ROW_GATES: DashboardRowGates = { agentCollaborationNetwork: false };

/**
 * `InsightsSectionData` feeding the real "stats" row's five KPI tiles
 * (`kpi:sessions`, `kpi:cost`, `kpi:merged`, `kpi:pr-size`, `kpi:kloc`) exactly
 * as `DashboardRowContent` / `TileRow` / `OverviewKpiCard` read it in
 * production, in place of the `useDeliveryInsights` / `useUtilizationInsights`
 * hooks that resolve to this shape on the real page (that data layer is the one
 * thing this surface cannot borrow, same as the Sessions surface's `listState`).
 * No shared fixture builds a full section response covering every KPI this row
 * reads, so the values below are hand-built to the wire shape rather than
 * lookalike markup. `prTrend` reuses the shared `makeTimeSeries` builder since
 * its "merged"-keyed shape is exactly what that helper already produces.
 */
const DASHBOARD_SECTIONS: InsightsSectionData = {
  [InsightsSection.Delivery]: {
    kpis: [
      {
        deltaBasis: KpiDeltaBasis.Computed,
        deltaPct: 12,
        format: KpiFormat.Currency,
        key: InsightsKpiKey.Cost,
        label: "Cost",
        sub: "Agent spend this period",
        value: 4206,
      },
      {
        deltaBasis: KpiDeltaBasis.Computed,
        deltaPct: 4,
        format: KpiFormat.Number,
        key: InsightsKpiKey.Merged,
        label: "Merged PRs",
        sub: "pull requests merged",
        value: 92,
      },
      {
        deltaBasis: KpiDeltaBasis.NotComputed,
        deltaPct: null,
        format: KpiFormat.Number,
        key: InsightsKpiKey.PrSize,
        label: "Median PR size",
        sub: "lines changed per pull request",
        value: 148,
      },
      {
        deltaBasis: KpiDeltaBasis.NotComputed,
        deltaPct: null,
        format: KpiFormat.Number,
        key: InsightsKpiKey.Kloc,
        label: "KLOC merged",
        sub: "thousand lines merged",
        value: 12.4,
      },
    ],
    charts: {
      branchesWithoutPr: [],
      branchLifespan: [],
      meanTimeToMerge: [],
      prByRepo: [],
      prByState: [],
      prTrend: makeTimeSeries([
        ["2026-05-30", 9],
        ["2026-05-31", 11],
        ["2026-06-01", 8],
        ["2026-06-02", 14],
        ["2026-06-03", 12],
        ["2026-06-04", 16],
        ["2026-06-05", 13],
      ]),
    },
  } satisfies DeliveryInsightsResponse,
  [InsightsSection.Utilization]: {
    charts: {
      // No shared builder covers a "sessions"-keyed series (`makeTimeSeries`
      // above is fixed to "merged"), so this one chart is hand-built to the
      // same `TimeSeries` shape rather than borrowed.
      eventActivity: {
        points: [
          { date: "2026-05-30", values: { sessions: 96 } },
          { date: "2026-05-31", values: { sessions: 104 } },
          { date: "2026-06-01", values: { sessions: 88 } },
          { date: "2026-06-02", values: { sessions: 132 } },
          { date: "2026-06-03", values: { sessions: 118 } },
          { date: "2026-06-04", values: { sessions: 151 } },
          { date: "2026-06-05", values: { sessions: 141 } },
        ],
        series: [{ key: "sessions", label: "Sessions" }],
      },
      reviewQueue: [],
    },
    kpis: [
      {
        deltaBasis: KpiDeltaBasis.Computed,
        deltaPct: 12,
        format: KpiFormat.Number,
        key: InsightsKpiKey.Sessions,
        label: "Agent sessions",
        sub: "sessions started",
        value: 1284,
      },
    ],
  } satisfies UtilizationInsightsResponse,
};

/**
 * Spend and token-volume series for the real "models" row's `ModelUsageChart`.
 * Not sourced from a shared fixture: the chart-story's own generator
 * (`model-usage-chart.stories.tsx`) builds the same shape but is local to that
 * file, so this is hand-built to the `TimeSeries` wire shape rather than a
 * lookalike chart.
 */
const MODEL_NAMES = ["claude-opus", "claude-sonnet", "codex"];
const MODEL_SHARE = [0.54, 0.31, 0.15];
function modelTimeSeries(scale: number): TimeSeries {
  const days = [
    "2026-05-30",
    "2026-05-31",
    "2026-06-01",
    "2026-06-02",
    "2026-06-03",
    "2026-06-04",
    "2026-06-05",
  ];
  return {
    points: days.map((date, dayIndex) => ({
      date,
      values: Object.fromEntries(
        MODEL_NAMES.map((name, index) => [
          name,
          Number(
            (MODEL_SHARE[index] * scale * (1 + dayIndex * 0.08)).toFixed(2)
          ),
        ])
      ),
    })),
    series: MODEL_NAMES.map((name) => ({ key: name, label: name })),
  };
}
const MODEL_SPEND_SERIES = modelTimeSeries(600);
const MODEL_TOKEN_SERIES = modelTimeSeries(2_400_000);

const DASHBOARD_COPY = {
  heading: "Dashboard",
  description:
    "Agent-session telemetry across your organization's synced compute targets.",
} as const;

/**
 * The three readings the real "Recent Sessions" card can be in
 * (`insights-overview-dashboard.tsx`'s inline `RecentSessions`), named for what
 * the reader sees rather than for the query flag that produces it.
 */
const SESSIONS_STATES = ["populated", "loading", "unavailable"] as const;
type SessionsState = (typeof SESSIONS_STATES)[number];

const SESSIONS = mixedAgentSessionListFixtures;

type DashboardScreenProps = {
  /** Org-relative path the sidebar should mark as current. */
  activePath?: string;
  /** Page heading. */
  heading?: string;
  /** Supporting line under the heading. */
  description?: string;
  /** Show the five KPI cards across the top. */
  showMetrics?: boolean;
  /** Show the Recent sessions table. */
  showRecentSessions?: boolean;
  /** Show the Model usage breakdown. */
  showModelUsage?: boolean;
  /** Rows the fixture renders, up to the shared mixed-sync-state fixture's five. */
  sessionCount?: number;
  /** Which of the Recent Sessions card's three readings to render. */
  sessionsState?: SessionsState;
  /**
   * The dashboard's time window. It decides the KPI delta caption, which
   * production derives from this rather than writing a fixed phrase.
   */
  dateRange?: DateRange;
};

const DashboardScreen = ({
  dateRange = "7d",
  activePath = "/dashboard",
  description = DASHBOARD_COPY.description,
  heading = DASHBOARD_COPY.heading,
  sessionCount = SESSIONS.length,
  sessionsState = "populated",
  showMetrics = true,
  showModelUsage = true,
  showRecentSessions = true,
}: DashboardScreenProps) => (
  <AppScreenShell activePath={activePath} breadcrumbs={["Dashboard"]}>
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      {/* Hand-written on purpose: the real page
          (apps/app/.../dashboard/page.tsx) inlines this exact heading/copy
          pair above the composed dashboard rather than mounting a heading
          component, so there is no real component to mount here either. */}
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">{heading}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5">
        {/* Real component: `DashboardRowContent` rendering the "stats" row
            exactly as `InsightsOverviewDashboard` mounts it -- the same
            catalog-driven KPI tiles (design-system `MetricCard` /
            `CostMetricCard` underneath), reading the same
            `InsightsSectionData` shape the page's insights hooks resolve to. */}
        {showMetrics ? (
          <DashboardRowContent
            autonomySeries={undefined}
            deltaLabel={GROWTH_LABEL[dateRange]}
            gates={ROW_GATES}
            heatmap={undefined}
            modelSeries={undefined}
            row={STATS_ROW}
            sections={DASHBOARD_SECTIONS}
          />
        ) : null}

        {/* Real component: `AiImpactCard`, which production mounts directly
            under the stats row whenever that row is not loading. It derives its
            four figures from the same `InsightsSectionData` the tiles above
            read, so it cannot disagree with them. */}
        {showMetrics ? (
          <div className="mt-5">
            <AiImpactCard sections={DASHBOARD_SECTIONS} />
          </div>
        ) : null}

        {/* Real components: the same `DashboardCard` + `SyncedSessionsTable`
            pair the real page's inline `RecentSessions` composes, fed by the
            shared mixed-sync-state fixture instead of the page's
            `useAgentSessions` hook -- that hook is the page's data layer,
            which this surface cannot borrow (same reasoning as the Sessions
            surface's `listState`). The loading/unavailable copy below is
            copied verbatim from that same `RecentSessions`. */}
        {showRecentSessions ? (
          <DashboardCard
            description="Latest synced agent runs"
            title="Recent Sessions"
          >
            {sessionsState === "loading" ? (
              <div className="py-8 text-center text-[var(--muted-foreground)] text-sm">
                Loading sessions…
              </div>
            ) : null}
            {sessionsState === "unavailable" ? (
              <div className="py-8 text-center text-[var(--destructive)] text-sm">
                Recent sessions are temporarily unavailable.
              </div>
            ) : null}
            {sessionsState === "populated" ? (
              <SyncedSessionsTable
                emptyState={
                  <EmptyState
                    className="py-12"
                    description="No synced sessions have arrived yet."
                    icon={Clock3Icon}
                    title="No recent sessions"
                  />
                }
                getSessionHref={(item) => `#/sessions/${item.id}`}
                items={SESSIONS.slice(0, sessionCount)}
                visibleColumns={SESSIONS_GLANCEABLE_COLUMNS}
              />
            ) : null}
          </DashboardCard>
        ) : null}

        {/* Real component: `DashboardRowContent`'s "models" row, which wraps
            the real `ModelUsageChart` in the real `DashboardCard` chrome,
            below Recent Sessions. Production can seat a heatmap row between
            the two when that row is enabled; this surface does not mount one,
            so the pair sits adjacent here. */}
        {showModelUsage ? (
          <DashboardRowContent
            autonomySeries={undefined}
            deltaLabel={GROWTH_LABEL[dateRange]}
            gates={ROW_GATES}
            heatmap={undefined}
            modelSeries={MODEL_SPEND_SERIES}
            modelTokenSeries={MODEL_TOKEN_SERIES}
            row={MODELS_ROW}
            sections={DASHBOARD_SECTIONS}
          />
        ) : null}
      </div>
    </div>
  </AppScreenShell>
);

/**
 * The landing screen after signing in, showing an organization's overall
 * activity at a glance rather than drilling into one session or branch.
 */
const meta = {
  title: "Surfaces/Dashboard",
  component: DashboardScreen,
  tags: ["autodocs"],
  argTypes: {
    activePath: {
      options: NAV_PATHS,
      control: { type: "select" },
      description: "Which sidebar destination renders as current.",
      table: { category: "Shell" },
    },
    sessionCount: {
      control: { type: "number", min: 0, max: SESSIONS.length, step: 1 },
      description:
        "Rows the table renders, up to the shared fixture's five mixed-sync-state sessions.",
      table: { category: "Content" },
    },
    heading: { control: "text", table: { category: "Content" } },
    description: { control: "text", table: { category: "Content" } },
    showMetrics: {
      control: "boolean",
      description: "The five KPI cards across the top.",
      table: { category: "Composition" },
    },
    showRecentSessions: {
      control: "boolean",
      description: "The Recent sessions table.",
      table: { category: "Composition" },
    },
    showModelUsage: {
      control: "boolean",
      description: "The Model usage breakdown.",
      table: { category: "Composition" },
    },
    dateRange: {
      options: ["7d", "30d", "90d", "all"],
      control: { type: "radio" },
      description:
        "The window the figures cover. It also sets the delta caption: WoW, MoM, QoQ, or all time.",
      table: { category: "Content" },
    },
    sessionsState: {
      options: SESSIONS_STATES,
      control: { type: "radio" },
      description:
        "The three readings the Recent Sessions card can be in: rows, pending, or could not load.",
      table: { category: "State" },
    },
  },
  args: {
    dateRange: "7d",
    activePath: "/dashboard",
    description: DASHBOARD_COPY.description,
    heading: DASHBOARD_COPY.heading,
    sessionCount: SESSIONS.length,
    sessionsState: "populated",
    showMetrics: true,
    showModelUsage: true,
    showRecentSessions: true,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DashboardScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Filters narrowed the list to nothing. The real `SyncedSessionsTable` empty
 * state renders in place of the row, which the hand-built table never had. */
export const NoSessions: Story = {
  name: "No sessions",
  args: { sessionCount: 0 },
};

/** The read failed. The real `RecentSessions` degraded-state copy renders
 * instead of a table, rather than the hand-built version's silent header. */
export const RecentSessionsUnavailable: Story = {
  name: "Recent sessions unavailable",
  args: { sessionsState: "unavailable" },
};

/** Metrics only, the arrangement while the lower panels are still loading. */
export const MetricsOnly: Story = {
  name: "Metrics only",
  args: { showModelUsage: false, showRecentSessions: false },
};
