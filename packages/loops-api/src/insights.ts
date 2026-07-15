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
// `org` aggregates the whole organization; `team` requires a team id and
// filters to members of that team.
export const InsightsScope = {
  Me: "me",
  Org: "org",
  Team: "team",
} as const;
export type InsightsScope = (typeof InsightsScope)[keyof typeof InsightsScope];

export const INSIGHTS_SCOPE_OPTIONS = [
  InsightsScope.Me,
  InsightsScope.Org,
  InsightsScope.Team,
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

export const InsightsTileAvailabilityState = {
  Available: "available",
  Gated: "gated",
  Unavailable: "unavailable",
} as const;
export type InsightsTileAvailabilityState =
  (typeof InsightsTileAvailabilityState)[keyof typeof InsightsTileAvailabilityState];

export type InsightsTileAvailabilityMap = Record<
  string,
  InsightsTileAvailabilityState
>;

export const InsightsGitHubProvenanceState = {
  Active: "active",
  Disconnected: "disconnected",
} as const;
export type InsightsGitHubProvenanceState =
  (typeof InsightsGitHubProvenanceState)[keyof typeof InsightsGitHubProvenanceState];

export type InsightsGitHubProvenance = {
  state: InsightsGitHubProvenanceState;
  checkedAt: string;
};

export type KpiStat = {
  key: string;
  label: string;
  // `null` means the metric has no computable value for this window (e.g.
  // median PR size when no PR is LOC-enriched yet). Consumers must render an
  // honest empty state (`—`) rather than coercing to 0. Serializes cleanly over
  // JSON (unlike a non-finite number).
  value: number | null;
  format: KpiFormat;
  sub: string;
  // Percent change vs. the immediately prior window of equal length. Null when
  // there is no prior window (e.g. the "all time" period) or no prior data.
  deltaPct: number | null;
  // Internal (non-tile) KPI: emitted in the response for consumers that read it
  // by key (e.g. the AI-Impact card's `mergedCount` denominator) but not meant
  // to render as its own dashboard tile. Mirrors the delivery-kpis SSOT
  // registry's `internal` flag. Omitted (undefined) for the common
  // tile-backing case. FEA-2946.
  internal?: boolean;
};

// Builds a KpiStat, shared by the cloud (`apps/api`) and desktop insights
// backends. Both rebuild this response contract and previously hand-rolled
// byte-identical copies; hoisted here (FEA-2900) so they can't drift.
// `deltaPct` defaults to null for tiles that have no period-over-period
// comparison (e.g. token totals, or the "all time" period). `internal` defaults
// to false; pass true for response-only KPIs that back no tile (see KpiStat).
export function kpi(
  key: string,
  label: string,
  value: number | null,
  format: KpiFormat,
  sub: string,
  deltaPct: number | null = null,
  internal = false
): KpiStat {
  return internal
    ? { key, label, value, format, sub, deltaPct, internal }
    : { key, label, value, format, sub, deltaPct };
}

const PERCENT_SCALE = 100;

/**
 * Period-over-period percent change of `current` vs `prior`, rounded to a whole
 * percent. Returns null when `prior` is 0: there is no baseline magnitude to
 * form a percentage against, so callers render a hidden delta chip rather than a
 * misleading value — this is the empty-prior case the {@link KpiStat.deltaPct}
 * contract calls out as "no prior data".
 *
 * FEA-2895: single source of truth for the cloud (`apps/api`) and desktop
 * (`apps/desktop`) insights dashboards, which previously carried drifted copies
 * (desktop returned +100% off a 0 prior and rounded to 1 decimal), so the same
 * KPI reported a different percent-change on web vs desktop. Both surfaces now
 * import this helper.
 */
export function pctDelta(current: number, prior: number): number | null {
  if (prior === 0 || !Number.isFinite(current) || !Number.isFinite(prior)) {
    return null;
  }
  return Math.round(((current - prior) / prior) * PERCENT_SCALE);
}

export type CategoryBucket = {
  key: string;
  label: string;
  value: number;
};

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// A single histogram bucket spec, ordered ascending by `max`. A value falls into
// the first bucket whose `max` it is strictly less than; the final bucket must
// use `Number.POSITIVE_INFINITY` so every non-negative value lands somewhere.
type HistogramBucketSpec = {
  key: string;
  label: string;
  max: number;
};

// Time-to-merge (PR open → merge) latency buckets, in milliseconds.
// Single source of truth for the cloud (`apps/api`) and desktop (`apps/desktop`)
// delivery-insights dashboards (FEA-2971): both previously carried diverged
// copies, so identical merge-latency data rendered with different boundaries.
const TTM_HISTOGRAM_BUCKETS: readonly HistogramBucketSpec[] = [
  { key: "lt4h", label: "< 4h", max: 4 * MS_PER_HOUR },
  { key: "4to12h", label: "4–12h", max: 12 * MS_PER_HOUR },
  { key: "12to24h", label: "12–24h", max: MS_PER_DAY },
  { key: "1to3d", label: "1–3d", max: 3 * MS_PER_DAY },
  { key: "gt3d", label: "> 3d", max: Number.POSITIVE_INFINITY },
];

// Branch-lifespan buckets, in milliseconds — a day/week-scale metric, so the
// boundaries are coarser than time-to-merge (FEA-2971).
const LIFESPAN_HISTOGRAM_BUCKETS: readonly HistogramBucketSpec[] = [
  { key: "short", label: "Short-lived (< 1d)", max: MS_PER_DAY },
  { key: "med", label: "Medium (1–7d)", max: 7 * MS_PER_DAY },
  { key: "long", label: "Long-lived (> 7d)", max: Number.POSITIVE_INFINITY },
];

// Counts `values` into `buckets` (ordered ascending by `max`), one CategoryBucket
// per spec entry. A value lands in the first bucket whose `max` it is strictly
// less than; values matching no bucket are dropped.
function histogram(
  values: number[],
  buckets: readonly HistogramBucketSpec[]
): CategoryBucket[] {
  const counts = buckets.map((b) => ({ ...b, value: 0 }));
  for (const value of values) {
    const bucket = counts.find((b) => value < b.max);
    if (bucket) {
      bucket.value += 1;
    }
  }
  return counts.map(({ key, label, value }) => ({ key, label, value }));
}

export function ttmHistogram(ttms: number[]): CategoryBucket[] {
  return histogram(ttms, TTM_HISTOGRAM_BUCKETS);
}

export function lifespanHistogram(lifespans: number[]): CategoryBucket[] {
  return histogram(lifespans, LIFESPAN_HISTOGRAM_BUCKETS);
}

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
  tileAvailability?: InsightsTileAvailabilityMap;
  githubProvenance?: InsightsGitHubProvenance;
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
  tileAvailability?: InsightsTileAvailabilityMap;
  githubProvenance?: InsightsGitHubProvenance;
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
  tileAvailability?: InsightsTileAvailabilityMap;
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
