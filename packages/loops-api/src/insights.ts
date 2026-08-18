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

/**
 * Whether the producer computes a period-over-period comparison for a metric at
 * all (ISS-4995). This is a statement about OUR capability, not about the
 * reader's data, and the two are not interchangeable: a null `deltaPct` on a
 * `Computed` metric means we ran the comparison and declined to report a
 * percentage for THIS window (see {@link KpiDeltaBasis.Computed} for the three
 * cases), while a null `deltaPct` on a `NotComputed` one means we never worked
 * the comparison out — no range and no amount of history will produce it.
 *
 * The producers genuinely differ per metric, which is why this rides the wire
 * instead of being re-derived from the key on the client: cloud computes a
 * comparison for `merged`/`cost`/`sessions`/`tool-runs`, desktop for
 * `merged`/`kloc`/`cost`/`pr-size`. A client-side key table would have to
 * duplicate both, and would state the wrong cause on one surface the first time
 * either producer moved.
 */
export const KpiDeltaBasis = {
  /**
   * The producer computes a comparison for this metric. `deltaPct` may still be
   * null, in exactly three cases — no prior window for the range; a prior base
   * too near zero to divide by ({@link NEAR_ZERO_DELTA_BASE}, FEA-3959); or a
   * magnitude at or past {@link MAX_DELTA_PCT} that {@link pctDelta} declines
   * to state rather than clamp (ISS-5003). Only the first is a history problem:
   * the other two are the comparison itself declining, on data that has a
   * perfectly good prior window. None of the three is a capability gap.
   */
  Computed: "computed",
  /** The producer computes no comparison for this metric. A gap on our side. */
  NotComputed: "not_computed",
} as const;
export type KpiDeltaBasis = (typeof KpiDeltaBasis)[keyof typeof KpiDeltaBasis];

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
  // there is no prior window (e.g. the "all time" period), no prior data, a
  // near-zero prior base (FEA-3959), a magnitude the ±999% ceiling declines to
  // state (ISS-5003), or — see `deltaBasis` — no comparison computed at all.
  deltaPct: number | null;
  // Why a null `deltaPct` is null: whether this producer computes a comparison
  // for the metric at all (ISS-4995). Optional so a producer that predates it
  // omits the field entirely, and consumers degrade to the reason-agnostic
  // "no comparison" copy rather than asserting a cause they cannot support.
  deltaBasis?: KpiDeltaBasis;
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
// `internal` defaults to false; pass true for response-only KPIs that back no
// tile (see KpiStat).
//
// ISS-4995: this builds a metric with NO comparison capability — the honest
// default, since most KPIs on both producers have never had one. A metric whose
// prior window this producer actually computes is built by `comparableKpi`
// below, so the capability is declared at the one place that knows it (the call
// site holding the prior-window figure) rather than inferred downstream.
//
// Review thread (insights.ts:161): it takes NO `deltaPct`, deliberately. While
// it did, `kpi(…, reportDelta(a, b))` compiled and emitted a KPI carrying a real
// computed delta while declaring the producer computes none — and the reverse,
// a null delta from a producer that DID compute, told the reader "we don't
// compute this yet" when the truth was "no prior window for this range". That
// wrong-cause claim is the whole point of ISS-4995, so the contradiction is now
// unrepresentable rather than merely unused: the emitted `deltaBasis` is
// inferable from the constructor alone.
export function kpi(
  key: string,
  label: string,
  value: number | null,
  format: KpiFormat,
  sub: string,
  internal = false
): KpiStat {
  return buildKpi(
    { key, label, value, format, sub, deltaPct: null, internal },
    KpiDeltaBasis.NotComputed
  );
}

/**
 * A KPI whose period-over-period comparison this producer DOES compute — pass
 * the reporter's result as `deltaPct`.
 *
 * Use this wherever a prior-window figure is computed, even though `deltaPct`
 * can still come back null: on this metric a null means the range has no
 * comparable prior period, which is a fact about the window and reads very
 * differently to a reader than "we don't compute this". Reaching for plain
 * `kpi()` here would tell them we never worked it out.
 */
export function comparableKpi(
  key: string,
  label: string,
  value: number | null,
  format: KpiFormat,
  sub: string,
  deltaPct: number | null,
  internal = false
): KpiStat {
  return buildKpi(
    { key, label, value, format, sub, deltaPct, internal },
    KpiDeltaBasis.Computed
  );
}

function buildKpi(
  fields: Omit<KpiStat, "deltaBasis"> & { internal: boolean },
  deltaBasis: KpiDeltaBasis
): KpiStat {
  const { internal, ...rest } = fields;
  return internal ? { ...rest, deltaBasis, internal } : { ...rest, deltaBasis };
}

const PERCENT_SCALE = 100;

/**
 * FEA-3959: near-zero prior-base floor. On a young product the prior window
 * often holds a tiny magnitude (1 session, $0.30 of spend), so dividing by it
 * yields a division artifact — "+5400% QoQ" — that reads as an explosive trend
 * when it only means "we went from ~nothing to a normal amount". A percentage
 * needs a meaningful baseline to describe a trend, so any prior whose magnitude
 * is below this floor is treated as "no baseline" (delta suppressed → callers
 * render the honest "no prior data" affordance) rather than a mega-percentage.
 * The floor sits just under 1 so a whole prior count of 1 still forms a
 * comparison but sub-unit magnitudes (fractional spend/KLOC, rounding noise) do
 * not. Kept in the shared SSOT so cloud and desktop apply the identical guard.
 */
export const NEAR_ZERO_DELTA_BASE = 0.99;

/**
 * FEA-3959: sane ceiling for a rendered percent delta. Even with a valid
 * baseline, a large multiple (a count that quintupled → +400%) stops helping the
 * reader judge a trend and starts reading like a glitch.
 *
 * ISS-5003 changed what happens AT that boundary: a magnitude above the ceiling
 * is no longer clamped to it, it declines to compare (see {@link pctDelta}).
 * The constant stays the boundary of the meaningful range for both surfaces, and
 * {@link isDeltaCapped} stays the reader for ceiling values arriving from
 * version-skewed producers that still clamp.
 */
export const MAX_DELTA_PCT = 999;

/**
 * Period-over-period percent change of `current` vs `prior`, rounded to a whole
 * percent. Returns null when there is no usable baseline — `prior` is 0 OR its
 * magnitude is below {@link NEAR_ZERO_DELTA_BASE} (FEA-3959) — so callers render
 * a hidden / "no prior data" delta chip rather than a misleading division
 * artifact.
 *
 * ISS-5003: it ALSO returns null when the magnitude would exceed
 * {@link MAX_DELTA_PCT}, rather than clamping to that ceiling. FEA-3959 already
 * established the ceiling's premise — past it "a large multiple stops helping
 * the reader judge a trend and starts reading like a glitch" — but then rendered
 * the glitch anyway as ">999%". Declining is the honest completion of that same
 * reasoning: `NEAR_ZERO_DELTA_BASE` deliberately admits a whole prior count of
 * 1, so a user's first real 90-day window (1 prior session → 4,257) produced a
 * 425,600% ratio that surfaced as a confident "↑ >999%" growth claim sitting
 * beside seven honest "No comparison" cards. That is not a big number; it is a
 * ratio against a baseline too small to be one, and the product asserted it as
 * fact. "No comparison" is a state this surface already ships and already
 * renders on most of its cards.
 *
 * The trade this makes: a genuine large-baseline multiple (100 → 2,000) also
 * stops reporting a percentage. That is the FEA-3959 ceiling's own verdict on
 * such magnitudes, not a new one. Preserving the movement as an absolute
 * from → to pair is the richer treatment, and needs a wire field and a chip
 * this contract does not have yet; it is deliberately deferred rather than
 * approximated here.
 *
 * The return stays a plain `number | null` so the cross-process
 * `deltaPct` contract is unchanged and version-skewed peers still receive a
 * finite, sane percentage or an explicit "no comparison".
 *
 * FEA-2895: single source of truth for the cloud (`apps/api`) and desktop
 * (`apps/desktop`) insights dashboards, which previously carried drifted copies
 * (desktop returned +100% off a 0 prior and rounded to 1 decimal), so the same
 * KPI reported a different percent-change on web vs desktop. Both surfaces now
 * import this helper.
 */
export function pctDelta(current: number, prior: number): number | null {
  if (!(Number.isFinite(current) && Number.isFinite(prior))) {
    return null;
  }
  // Near-zero (incl. exactly-zero) prior → no baseline to form a percentage.
  if (Math.abs(prior) < NEAR_ZERO_DELTA_BASE) {
    return null;
  }
  const raw = Math.round(((current - prior) / prior) * PERCENT_SCALE);
  // At or beyond the ceiling the ratio is not a figure this product can assert,
  // so it declines to compare rather than clamping to a scary cap (ISS-5003).
  //
  // The comparison is `>=`, not `>` (review thread). With `>`, an exactly-999%
  // change survived — and `formatDeltaPct` has no way to tell it apart from a
  // clamp, so it rendered that precise, honest figure as `>999%`: a bound the
  // product does not have, on a PR whose whole thesis is not asserting one. `>=`
  // gives up the exact-999 case (it now reads "No comparison", the same state
  // every other over-ceiling magnitude gets) and in exchange makes `>999%` a TRUE
  // statement for every value this build can produce, because this build can no
  // longer produce a ±999 at all. That is what leaves `isDeltaCapped` /
  // `formatDeltaPct` as a pure version-skew compatibility path, which is exactly
  // what their docstrings claim they are.
  if (Math.abs(raw) >= MAX_DELTA_PCT) {
    return null;
  }
  return raw;
}

/**
 * True when `deltaPct` sits at the {@link MAX_DELTA_PCT} ceiling, so a delta chip
 * renders a "capped" affordance (">999%" / "<-999%") instead of the bare figure.
 * Null / sub-ceiling deltas are not capped.
 *
 * PURE VERSION-SKEW COMPATIBILITY PATH since ISS-5003. {@link pctDelta} declines
 * at or beyond the ceiling, so THIS build cannot produce a ±999 at all — every
 * ±999 that reaches this function came from a version-skewed producer (an older
 * desktop build, or a cached payload) where the value DOES mean a clamp. That is
 * what makes the ">999%" / "<-999%" render a true statement rather than a bound
 * asserted over a precise figure: there is no longer an exactly-999 case for it
 * to mislabel.
 *
 * Retained deliberately, per the Compatibility Guardrail: removing it would
 * strand those peers on an unlabelled figure that reads as a precise 999%.
 *
 * The wire contract (`deltaPct: number | null`) still carries no clamp marker, so
 * this check necessarily infers the clamp from the value alone — which is sound
 * only because the sole remaining producer of a ±999 is a clamping one. Adding an
 * explicit additive `deltaCapped` field to the KpiStat contract, wired through
 * both producers and all three UI surfaces, is deferred as its own change.
 */
export function isDeltaCapped(deltaPct: number | null): boolean {
  return deltaPct !== null && Math.abs(deltaPct) >= MAX_DELTA_PCT;
}

/**
 * Single owner of the delta-chip display string, shared by every delta surface
 * (the design-system `MetricCard` chip and the Insights `TrendBadge`) so the cap
 * treatment can't drift between the tile and the card. Returns `null` when there
 * is no comparison (`deltaPct === null`) — callers render the "no trend" chip.
 *
 * A delta clamped to {@link MAX_DELTA_PCT} renders with a comparison glyph that
 * carries direction — `">999%"` / `"<-999%"` — rather than a double-plus
 * `"+999%+"` (which reads like a typo) or `"-999%+"` (which reads like the drop
 * is shrinking). Sub-ceiling deltas render as a plain signed percent
 * (`"+42%"` / `"-8%"` / `"0%"`).
 */
export function formatDeltaPct(deltaPct: number | null): string | null {
  if (deltaPct === null) {
    return null;
  }
  if (isDeltaCapped(deltaPct)) {
    return deltaPct >= 0 ? `>${MAX_DELTA_PCT}%` : `<-${MAX_DELTA_PCT}%`;
  }
  const sign = deltaPct > 0 ? "+" : "";
  return `${sign}${deltaPct}%`;
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
  // null signals "no activity data" (distinct from 0 which means "measured zero").
  values: Record<string, number | null>;
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
    // Additive: hour×day turn density split by session mode. Computed by both the
    // desktop-local backend and the cloud `/insights/utilization` route (FEA-3684);
    // older peers omit it and clients render a graceful empty state.
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

/**
 * One agent/subagent type node in the aggregate pipeline graph (FEA-3537).
 * This is the SSOT for the agent-effectiveness row shape: `@repo/design-system`
 * aliases `WorkflowEffectivenessItem` to this type (loops-api is the lowest-level
 * package both consumers share), so the dashboard passes nodes straight through
 * and the two can never drift.
 */
export type AgentPipelineNode = {
  subagentType: string;
  total: number;
  completed: number;
  errors: number;
  sessions: number;
  successRate: number;
  avgDuration: number | null;
  trend: number[];
};

/** A weighted, directed hand-off between two agent types. */
export type AgentPipelineEdge = {
  source: string;
  target: string;
  weight: number;
};

/**
 * Aggregate agent-collaboration graph for the selected scope + period: nodes are
 * agent/subagent types (sized by run count), edges are weighted hand-offs
 * between them. Rendered below the model-usage chart on the Dashboard.
 */
export type AgentPipelineGraphData = {
  nodes: AgentPipelineNode[];
  edges: AgentPipelineEdge[];
};

export type AgentsInsightsResponse = {
  kpis: KpiStat[];
  tileAvailability?: InsightsTileAvailabilityMap;
  charts: {
    modelUsageOverTime: TimeSeries;
    // Additive: per-day per-model TOKEN volume (input + output + cacheRead +
    // cacheWrite), the usage counterpart to `modelUsageOverTime` (USD spend).
    // Shares the same series keys/order so the dashboard's $/# toggle only swaps
    // y-values. Older peers may omit it and clients degrade to spend-only.
    modelTokensOverTime?: TimeSeries;
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
    // Additive (FEA-3537): aggregate agent-pipeline collaboration graph — nodes
    // are agent/subagent types (sized by run count), edges are weighted hand-offs
    // between them. Omitted by peers that don't compute it; clients render a
    // graceful empty state. Rendered below the model-usage chart on the Dashboard.
    agentPipeline?: AgentPipelineGraphData;
    // Additive (FEA-4022 / PLN-1481): daily mean session frustration, NORMALIZED
    // 0 (calm) → 100 (peak) against the org population's observed max raw signal
    // over the window. The raw signal is org-scoped, unbounded, and drifts as more
    // sessions land, so it is normalized here at aggregation time rather than
    // frozen per-row. Single series keyed "frustration". Omitted (undefined) when
    // the org has NOT opted into `calculateSessionFrustration` OR no session in the
    // window carries a raw signal — clients render a disabled/empty state.
    frustrationTrend?: TimeSeries;
    // Additive (ISS-4463 "TokenOps"): USD spend split by the originating
    // session's lifecycle outcome, keyed by {@link SpendOutcome}. Buckets sum
    // exactly to the period's total session spend (allocated to cents, so the
    // parts conserve the whole). Omitted by peers that do not compute it, so
    // clients render a graceful empty state rather than failing the dashboard.
    spendByOutcome?: CategoryBucket[];
  };
};

/**
 * ISS-4994: the caption under the Dashboard "Cost" KPI, owned as a named
 * constant so what the number IS can be asserted rather than re-typed.
 *
 * Lives HERE, in the shared `@closedloop-ai/loops-api` insights module, and not in
 * `apps/api` (review thread). BOTH producers of this KPI render a caption for it
 * — the cloud service and desktop's `local-insights.ts`, which computes the same
 * subscription-inclusive `SUM(cost_usd_estimated)` with no billing-mode predicate
 * — so a constant only `apps/api` could import would have fixed the claim on one
 * surface and left the other saying "estimated AI spend in window" over the very
 * same number. `pctDelta` is shared through this module for exactly this reason;
 * the caption now is too.
 *
 * ONE name for one number (review thread): "estimated cost". The first cut said
 * "modelled cost", which made a third name for this figure after the KPI info
 * copy's "Estimated cost" and the chart titles' "Cost" — and was the only
 * British spelling on the screen. Every surface that describes this quantity now
 * says "estimated cost": this caption, `metric-info.ts`'s `kpi:cost`, the
 * `AiImpactCard` ratio detail, and the model-usage chart description.
 *
 * The KPI sums `sessionDetail.estimatedCost` with NO billing-mode predicate, so
 * it is the subscription-INCLUSIVE modelled total. On real org data most of it
 * is usage a subscription already covered — money that never left the account.
 * The previous caption, "spend in range", asserted the opposite, while the
 * Sessions surface split the very same dollars and correctly captioned the
 * covered portion "if billed to API". One product, one number, two verbs.
 *
 * This names the basis instead of guessing at the verb. It deliberately does NOT
 * change the value: narrowing the KPI to metered-only — which
 * `packages/api/src/insights/delivery-kpis/registry.ts` argues for, and which
 * `computeSessionCostSplit` already implements for Sessions — restates every
 * historical Dashboard total and the cost-per-PR tile derived from it. That is a
 * migration with its own reconciliation, not a caption fix. Stopping the number
 * from lying about what it is comes first.
 */
export const COST_KPI_SUB =
  "estimated cost in range, including subscription-covered usage";

/**
 * The single definition of a session's outcome for every analytics surface.
 *
 * Every surface that talks about a "failed" session reads this and nothing
 * else, so two screens can never disagree about which sessions failed.
 *
 * FOUR states, on TWO independent axes — terminality and verdict.
 * `SessionDetail.endsWithError` carries only the verdict, so it cannot answer
 * whether a session ended at all:
 *
 *  - {@link SpendOutcome.Running} — no `sessionEndedAt`, so the session has not
 *    ended. This state exists because `endsWithError` is NOT a terminality
 *    signal: the desktop stamps a non-null 0/1 on ACTIVE rows too
 *    (`write-core.ts` refreshes it on every re-import, `live-hook.ts` resets it
 *    to 0 as a row reactivates) and syncs that `false` to the cloud. Reading a
 *    live session's `false` as "ended clean" hands a terminal verdict to a
 *    session that has not finished and may still fail, so terminality is decided
 *    by `sessionEndedAt` — this surface's existing definition of an open session.
 *    {@link outcomeForEndsWithError} therefore CANNOT return it: that classifier
 *    sees only the verdict, and a caller that knows the session is still running
 *    must say so itself (ISS-4463).
 *  - {@link SpendOutcome.Clean} / {@link SpendOutcome.Errored} — the session
 *    ended, and its own logs recorded which way.
 *  - {@link SpendOutcome.Unknown} — the session ended but no verdict was ever
 *    recorded (pre-ISS-4586 rows, and older desktop builds that do not sync the
 *    flag). Labelled "Not recorded", because that is the fact: our capture is
 *    missing, not the session's outcome.
 *
 * Folding `Unknown` into `Clean` would overstate healthy work; folding it into
 * `Errored` would invent failure that was never observed. It is therefore never
 * folded into either side, and neither is `Running`.
 *
 * DELIBERATE DIVERGENCE from the stale-session reaper (wongk, ISS-4586): the
 * reaper reads a null `endsWithError` as not-error and publishes an orphaned
 * session as INACTIVE. That is a DISPOSITION — it must pick some terminal status
 * for a row nothing will update again, and "finished, not failed" is the
 * conservative pick. This vocabulary is an ATTRIBUTION — it reports what was
 * actually observed, and a null was never observed either way. The two answer
 * different questions on purpose, so the same record can read INACTIVE in the
 * Sessions list and "Not recorded" here.
 */
export const SpendOutcome = {
  Clean: "clean",
  Errored: "errored",
  Running: "running",
  Unknown: "unknown",
} as const;
export type SpendOutcome = (typeof SpendOutcome)[keyof typeof SpendOutcome];

/**
 * Display labels for {@link SpendOutcome}. Held here in the shared SSOT beside
 * the vocabulary so every producer — the cloud services, the app tiles, and the
 * desktop-local backend — names an outcome identically instead of re-deriving
 * copy.
 */
export const SPEND_OUTCOME_LABELS: Record<ClassifiedSpendOutcome, string> = {
  [SpendOutcome.Clean]: "Ended clean",
  [SpendOutcome.Errored]: "Ended with error",
  // For a surface driven by `outcomeOf`, this bucket is the UNION of "never
  // recorded" and "not terminal yet", so it must not claim the narrower
  // "Not recorded" — see SPEND_OUTCOME_LABELS_WITH_RUNNING.
  [SpendOutcome.Unknown]: "Outcome unknown",
};

/**
 * Labels for the terminality-aware family ({@link
 * SPEND_OUTCOME_ORDER_WITH_RUNNING}).
 *
 * Identical to {@link SPEND_OUTCOME_LABELS} except for `Unknown`, and DERIVED
 * from it so `Clean`/`Errored` can never drift between the two families. Once
 * `Running` is its own bucket, a null verdict means only one thing — we never
 * captured it — so "Not recorded" is the precise statement, where the coarser
 * family has to keep the vaguer "Outcome unknown" because its bucket also holds
 * sessions that simply have not finished.
 */
export const SPEND_OUTCOME_LABELS_WITH_RUNNING: Record<SpendOutcome, string> = {
  ...SPEND_OUTCOME_LABELS,
  [SpendOutcome.Running]: "Still running",
  [SpendOutcome.Unknown]: "Not recorded",
};

/**
 * The outcomes a classifier keyed on `endsWithError` can actually emit.
 *
 * {@link SpendOutcome.Running} is excluded by construction: neither
 * {@link outcomeForEndsWithError} nor `outcomeOf` (which folds a non-terminal
 * session into `Unknown`) can return it, because neither is given a terminality
 * signal. A surface driven by those classifiers should key its exhaustive maps
 * on THIS type, not the full union — that way the map stays complete, the
 * three-bucket contract is enforced by the compiler, and the surface cannot grow
 * a bucket its own data can never fill.
 */
export type ClassifiedSpendOutcome = Exclude<
  SpendOutcome,
  typeof SpendOutcome.Running
>;

/**
 * Fixed presentation order for the THREE outcomes a classifier keyed on
 * `endsWithError` can emit, so the buckets never reshuffle between reads.
 *
 * Deliberately excludes {@link SpendOutcome.Running}: neither
 * {@link outcomeForEndsWithError} nor `outcomeOf` (which folds a non-terminal
 * session into `Unknown`) can return it, so a surface driven by those
 * classifiers would render a permanently-empty "Still running" bucket. A
 * producer that resolves terminality itself uses
 * {@link SPEND_OUTCOME_ORDER_WITH_RUNNING} instead.
 */
export const SPEND_OUTCOME_ORDER: readonly ClassifiedSpendOutcome[] = [
  SpendOutcome.Clean,
  SpendOutcome.Errored,
  SpendOutcome.Unknown,
];

/**
 * Presentation order for producers that resolve terminality themselves — today
 * the Insights Agents spend-by-outcome lens (cloud and desktop-local), which
 * decides "ended" from `sessionEndedAt` in its own query rather than inferring
 * it from `endsWithError`.
 *
 * Splitting `Running` out is strictly more informative than folding it into
 * `Unknown`: a running session's outcome is not missing from our capture, it
 * simply has not happened yet, and folding the two overstates how much of our
 * own data we have lost track of. `Errored` is identical under both orders, so
 * the two families never disagree about which sessions FAILED — the shared
 * guarantee — they differ only in how they present spend that has no verdict
 * YET versus spend whose verdict was never recorded.
 */
export const SPEND_OUTCOME_ORDER_WITH_RUNNING: readonly SpendOutcome[] = [
  SpendOutcome.Clean,
  SpendOutcome.Errored,
  SpendOutcome.Running,
  SpendOutcome.Unknown,
];

/**
 * The canonical classifier. Exported rather than left private to any one
 * service precisely so a second surface cannot re-derive the null mapping
 * locally — that drift is the defect this symbol exists to prevent.
 */
export function outcomeForEndsWithError(
  endsWithError: boolean | null
): SpendOutcome {
  if (endsWithError === true) {
    return SpendOutcome.Errored;
  }
  if (endsWithError === false) {
    return SpendOutcome.Clean;
  }
  return SpendOutcome.Unknown;
}

/**
 * Which PRs a surface's KLOC / Median-PR-size tiles are taken over, as the noun
 * {@link withSizeCoverage} prints.
 *
 * A parameter rather than a hardcoded "merged PRs" because the two producers
 * genuinely measure different populations here, the same way the visible tile
 * is labelled "KLOC merged" on cloud and "KLOC captured" on desktop: cloud sums
 * merged PRs, desktop sums every captured PR in the window. Printing "merged"
 * on desktop would name a population those tiles do not measure.
 *
 * The Merged noun keeps "deduped" because cloud's scan IS deduped
 * (`dedupeMergedPrs`), and naming what a number is taken over is the point of
 * the noun. ISS-5411 put the "Merged PRs" tile beside it on the same
 * pull-request basis, so a collapsing duplicate pair no longer moves one number
 * without the other — the cap is what still makes the two legitimately differ
 * (see the `withSizeCoverage` doc below). Without the word, the caption would
 * present the deduped scan as if it were that tile's population — the
 * wrong-denominator trap the `mergedPrsScanned` KPI's own caption ("deduped
 * merged PRs…") already names. Desktop's captured scan performs no dedupe, so
 * its noun stays bare.
 */
export const SizeCoveragePopulation = {
  Merged: "deduped merged PRs",
  Captured: "captured PRs",
} as const;
export type SizeCoveragePopulation =
  (typeof SizeCoveragePopulation)[keyof typeof SizeCoveragePopulation];

/** Separates a KPI caption from a trailing qualifying clause. */
const KPI_SUB_CLAUSE_SEPARATOR = " · ";

/**
 * ISS-5414: appends "sized N of M <population>" to a KPI caption — the
 * reader-facing half of PLN-1535 M4's size-coverage pair.
 *
 * KLOC and Median PR size are taken over the PRs whose diff we can actually
 * size, not over every PR in the window. Both producers already emit how wide
 * that gap is (cloud's `mergedPrsScanned` / `mergedPrsWithoutLoc`, desktop's
 * `capturedPrsScanned` / `capturedPrsWithoutLoc` — each named for the population
 * its own tiles measure), but the pair is `internal` on both surfaces — it backs
 * no tile of its own — so nothing rendered it and the
 * tiles presented a partial-coverage lower bound as if it were the whole
 * figure. This clause is where the pair reaches a reader.
 *
 * Composed here, in the module both producers already share for KPI copy (see
 * `COST_KPI_SUB`), so the cloud and desktop dashboards cannot word the same
 * caveat two ways.
 *
 * The clause is emitted even at FULL coverage (`N === M`). "sized 19 of 19
 * deduped merged PRs scanned" is the affirmative a reader needs: dropping it once the
 * gap closes would make a complete figure indistinguishable from one produced by
 * a build that never reported coverage at all. An empty scan (`M === 0`) is the
 * one case with nothing to say — there is no population for the figure to be a
 * share of — so the caption is returned untouched.
 *
 * It says "scanned", not just the population noun, because `M` is the ROW SCAN
 * the producer actually performed, which is not always the whole population:
 * cloud's is deduped and bounded by `MERGED_PR_SCAN_CAP`, while the "Merged PRs"
 * tile beside it is an exact uncapped count. Once that cap binds the two
 * legitimately disagree, and a bare "of 25,000 merged PRs" next to a tile
 * reading 30,000 would assert a total this producer never counted — the
 * wrong-denominator trap PLN-1535 M4 kept this pair internal to avoid.
 */
export function withSizeCoverage(
  sub: string,
  scanned: number,
  withoutLoc: number,
  population: SizeCoveragePopulation
): string {
  if (scanned <= 0) {
    return sub;
  }
  // Clamped: a version-skewed or miscounted producer reporting more unsized PRs
  // than it scanned must not print a negative sized count.
  const sized = Math.max(0, scanned - withoutLoc);
  return `${sub}${KPI_SUB_CLAUSE_SEPARATOR}sized ${sized} of ${scanned} ${population} scanned`;
}
