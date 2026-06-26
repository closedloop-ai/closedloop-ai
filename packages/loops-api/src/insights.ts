// Shared Insights types for the native analytics surface. Consumed by the API,
// app, and desktop surfaces. Values are returned as numbers plus a `format`
// hint so the server stays presentation-free and the frontend owns formatting.

export const INSIGHTS_FEATURE_FLAG_KEY = "insights" as const;

export const InsightsPeriod = {
  Week: "7",
  Month: "30",
  Quarter: "90",
  All: "all",
} as const;
export type InsightsPeriod =
  (typeof InsightsPeriod)[keyof typeof InsightsPeriod];

export const INSIGHTS_PERIOD_OPTIONS = [
  InsightsPeriod.Week,
  InsightsPeriod.Month,
  InsightsPeriod.Quarter,
  InsightsPeriod.All,
] as const;

export const InsightsSection = {
  Delivery: "delivery",
  Utilization: "utilization",
  Agents: "agents",
} as const;
export type InsightsSection =
  (typeof InsightsSection)[keyof typeof InsightsSection];

export const INSIGHTS_SECTION_OPTIONS = [
  InsightsSection.Delivery,
  InsightsSection.Utilization,
  InsightsSection.Agents,
] as const;

// Aggregation scope. `me` restricts to the current user's attributable data;
// `org` aggregates the whole organization. Team-level aggregation is a planned
// follow-up and is intentionally not part of this enum yet.
export const InsightsScope = {
  Me: "me",
  Org: "org",
} as const;
export type InsightsScope = (typeof InsightsScope)[keyof typeof InsightsScope];

export const INSIGHTS_SCOPE_OPTIONS = [
  InsightsScope.Me,
  InsightsScope.Org,
] as const;

// How a numeric KPI value should be rendered. `duration` and `tokens` values
// are raw numbers (milliseconds and token counts respectively); the frontend
// humanizes them.
export const KpiFormat = {
  Number: "number",
  Currency: "currency",
  Percent: "percent",
  Duration: "duration",
  Tokens: "tokens",
} as const;
export type KpiFormat = (typeof KpiFormat)[keyof typeof KpiFormat];

export type KpiStat = {
  key: string;
  label: string;
  value: number;
  format: KpiFormat;
  sub: string;
  // Percent change vs. the immediately prior window of equal length. Null when
  // there is no prior window (e.g. the "all time" period) or no prior data.
  deltaPct: number | null;
};

export type CategoryBucket = {
  key: string;
  label: string;
  value: number;
};

export type DonutSlice = {
  key: string;
  label: string;
  value: number;
};

export type TimeSeriesSeries = {
  key: string;
  label: string;
};

export type TimeSeriesPoint = {
  // Bucket date as YYYY-MM-DD (UTC day).
  date: string;
  // seriesKey -> value for that day. Series absent from a bucket are treated as 0.
  values: Record<string, number>;
};

export type TimeSeries = {
  series: TimeSeriesSeries[];
  points: TimeSeriesPoint[];
};

export type ReviewerRow = {
  reviewer: string;
  reviewed: number;
  approved: number;
  // Median time (ms) from PR open to this reviewer's first review. Null when
  // not computable.
  medianWaitMs: number | null;
};

export type DeliveryInsightsResponse = {
  kpis: KpiStat[];
  charts: {
    prTrend: TimeSeries;
    // Additive: older peers may omit this and clients should show an empty
    // state rather than failing the whole dashboard.
    klocTrend?: TimeSeries;
    prByRepo: CategoryBucket[];
    meanTimeToMerge: CategoryBucket[];
    prByState: CategoryBucket[];
    // Org-wide CI health. Omitted under `me` scope (not user-attributable).
    checkStatus?: DonutSlice[];
    branchLifespan: CategoryBucket[];
    branchesWithoutPr: CategoryBucket[];
  };
};

// Hour-of-day × day event-density grid, split by the originating session's
// mode: "human" (interactive — the session submitted at least one user prompt)
// vs "agent" (headless/autonomous — e.g. `-p` runs and spawned sub-agents,
// which never submit an interactive prompt). Powers the dashboard Event
// Activity heatmap with a Both/Agent/Human toggle.
export type ActivityHeatmapCell = {
  // Day column as YYYY-MM-DD (UTC day).
  day: string;
  // Hour-of-day row, 0..23 (UTC).
  hour: number;
  human: number;
  agent: number;
};

export type ActivityHeatmap = {
  // Contiguous ascending day columns covering the period, so the grid stays
  // dense even for days with no events.
  days: string[];
  // Sparse non-zero buckets; any (day, hour) absent here is zero.
  cells: ActivityHeatmapCell[];
};

export type UtilizationInsightsResponse = {
  kpis: KpiStat[];
  charts: {
    eventActivity: TimeSeries;
    // Additive (desktop-only today): hour×day event density split by session
    // mode. Older/web peers omit it; clients render a graceful empty state.
    activityHeatmap?: ActivityHeatmap;
    // Additive local/desktop analytics widgets. Older peers may omit these and
    // clients should render a graceful empty state.
    eventVolume?: TimeSeries;
    eventsByType?: CategoryBucket[];
    sessionsByStatus?: CategoryBucket[];
    // Sessions grouped by user. Omitted under `me` scope (single user).
    userBreakdown?: CategoryBucket[];
    // Reviewer workload keyed by GitHub login. Omitted under `me` scope (not
    // mappable to a single platform user).
    reviewerLoad?: ReviewerRow[];
    reviewQueue: CategoryBucket[];
  };
};

export type AgentsInsightsResponse = {
  kpis: KpiStat[];
  charts: {
    modelUsageOverTime: TimeSeries;
    modelBreakdown: CategoryBucket[];
    tokenDistribution?: CategoryBucket[];
    toolUsage?: CategoryBucket[];
    agentsByStatus?: CategoryBucket[];
    agentsByType?: CategoryBucket[];
    // Additive: older peers may omit this and clients should show an empty
    // state rather than failing the whole dashboard.
    toolRunsOverTime?: TimeSeries;
    // Additive (desktop-only today): daily median session-autonomy index, 0
    // (fully manual) → 100 (fully agentic). A SQL-derived index from the
    // agent-vs-human turn share — distinct from the richer read-time autonomy
    // score shown on session detail. Single series keyed "autonomy".
    autonomyTrend?: TimeSeries;
  };
};
