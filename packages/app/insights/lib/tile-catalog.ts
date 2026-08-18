import { InsightsSection } from "@repo/api/src/types/insights";
import { INSIGHTS_SPEND_OUTCOME_FLAG_KEY } from "@repo/api/src/types/insights-spend-outcome-flag";
import {
  InsightsKpiKey,
  KPI_METRIC_POLARITY,
} from "@repo/app/insights/lib/kpi-polarity";
import type { DonutSliceTexture } from "@repo/design-system/components/ui/donut-slice-textures";
import type { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import {
  SPEND_OUTCOME_COLORS,
  SPEND_OUTCOME_TEXTURE_MARK_COLORS,
  SPEND_OUTCOME_TEXTURES,
  SPEND_OUTCOME_ZERO_MESSAGE,
} from "./spend-outcome-palette";

export const TileKind = {
  Kpi: "kpi",
  CategoryBar: "category-bar",
  Donut: "donut",
  Heatmap: "heatmap",
  TimeSeries: "timeseries",
  TimeSeriesBar: "timeseries-bar",
  ReviewerTable: "reviewer-table",
} as const;
export type TileKind = (typeof TileKind)[keyof typeof TileKind];

export type TileGroupBy = {
  key: string;
  label: string;
};

type TileDescriptorBase = {
  id: string;
  section: InsightsSection;
  title: string;
  dataKey: string;
  metricKey: string;
  metricLabel: string;
  unitLabel?: string;
  groupBy?: TileGroupBy;
  horizontal?: boolean;
  // Render each category's value directly on the bar (in addition to the hover
  // tooltip) so it's readable at a glance. Opt-in per tile; category-bar only.
  showValueLabels?: boolean;
  infoKey?: string;
  /**
   * Cross-surface feature-flag key this tile is gated behind, or undefined for
   * an always-on tile. A gated tile is filtered out of BOTH reachable entry
   * points when its flag is off — the metric picker (so it cannot be added) and
   * the dashboard grid (so an already-pinned tile stops rendering) — via
   * {@link isTileEnabled}. The catalog stays a pure data table; resolving the
   * flag itself belongs to the components, which hold the flag adapter.
   */
  featureFlag?: string;
  /**
   * Fixed category-key → colour map for a tile whose categories are SEMANTIC,
   * not merely categorical. The generic index palette assigns colour by
   * position, which on a good/bad/unknown split paints meaning the data does not
   * have (and can accidentally suggest the opposite). Undefined keeps the index
   * palette, which is right for every open-ended dimension (models, repos,
   * tools).
   */
  colorByKey?: Readonly<Record<string, string>>;
  /**
   * Fixed category-key → texture map, adding a REDUNDANT non-colour channel for
   * category identity (ISS-5362). Donut tiles only, and only where the tile's
   * palette is SEMANTIC and therefore cannot be re-picked for colour-vision
   * separation without giving up the meaning it carries — see
   * {@link SPEND_OUTCOME_TEXTURES}. Undefined renders solid slices, which is
   * right for every dimension whose palette is free to be CVD-safe on its own.
   */
  textureByKey?: Readonly<Record<string, DonutSliceTexture>>;
  /**
   * Per-category override for the colour a texture's MARKS are drawn in
   * (ISS-5362, #4514 review). Marks default to the card token so a texture
   * reads as gaps punched in the slice; a category drawn faintly against that
   * same card has no ink to give up and names a darker achromatic colour here
   * instead — see {@link SPEND_OUTCOME_TEXTURE_MARK_COLORS}. Meaningless
   * without {@link TileDescriptorBase.textureByKey}.
   */
  textureMarkColorByKey?: Readonly<Record<string, string>>;
  /**
   * Print each slice's share of the whole in the legend. Donut tiles only, and
   * only where the tile's question IS "what share?" — a ring has no on-screen
   * denominator, so otherwise the reader is left estimating arcs.
   */
  showSharePercent?: boolean;
  /**
   * Message for a MEASURED zero — the query ran, the period is real, and every
   * bucket came back 0. Distinct from an ABSENT field (a peer that does not
   * compute this chart), which keeps the generic "no data" empty state. Without
   * this, "we looked and you spent nothing" and "we have nothing to show you"
   * render identically. Undefined keeps the existing shared empty state.
   */
  zeroStateMessage?: string;
  grid: { w: number; h: number };
};

/**
 * A KPI tile. `polarity` is REQUIRED here (not optional with a default) so the
 * delta chip's good/bad colour is always an explicit per-metric decision.
 */
export type KpiTileDescriptor = TileDescriptorBase & {
  kind: typeof TileKind.Kpi;
  /** Narrowed from the base `string`: a KPI tile's metric is a known KPI key. */
  metricKey: InsightsKpiKey;
  polarity: MetricPolarity;
};

/** A chart tile — no single period-over-period delta, so no polarity. */
export type ChartTileDescriptor = TileDescriptorBase & {
  kind: Exclude<TileKind, typeof TileKind.Kpi>;
  /**
   * ISS-5507: the chart-SHAPE half of a heading whose metric noun is
   * surface-dependent — "over time", "by day", "heatmap".
   *
   * The catalog is one cross-surface table, so a `title` written here is the
   * same string for every peer. That is wrong for a tile whose POPULATION
   * differs by surface: `chart:klocTrend` draws merged-PR KLOC on the cloud
   * dashboard and captured-PR KLOC on desktop — the merged-vs-captured split
   * FEA-2947 and the desktop "KLOC captured" KPI exist to keep straight — and
   * each producer already labels its own series accordingly. A tile that
   * declares a suffix has its heading rebuilt at render time from the
   * response's own metric noun plus this suffix, so the card cannot say "KLOC
   * merged over time" above a legend reading "KLOC captured".
   *
   * `title` stays the surface-agnostic default (used while the response is
   * still loading, and by every catalog reader that has no response in hand —
   * the metric picker, the share/export copy). It MUST read
   * `${metricLabel} ${titleSuffix}` so the two cannot drift; the catalog test
   * pins that.
   *
   * Undefined for every tile whose heading is fixed copy, which is the common
   * case — a suffix is only worth carrying where the surfaces disagree.
   */
  titleSuffix?: string;
};

export type TileDescriptor = KpiTileDescriptor | ChartTileDescriptor;

const KPI_GRID = { w: 3, h: 2 } as const;
const CHART_GRID = { w: 6, h: 4 } as const;
const WIDE_GRID = { w: 12, h: 4 } as const;

function kpiTile(
  section: InsightsSection,
  key: InsightsKpiKey,
  title: string,
  metricLabel = title,
  unitLabel?: string
): KpiTileDescriptor {
  return {
    id: `kpi:${key}`,
    section,
    title,
    kind: TileKind.Kpi,
    dataKey: key,
    metricKey: key,
    metricLabel,
    polarity: KPI_METRIC_POLARITY[key],
    ...(unitLabel ? { unitLabel } : {}),
    grid: KPI_GRID,
  };
}

function chartTile(
  input: Omit<ChartTileDescriptor, "grid"> & {
    wide?: boolean;
  }
): ChartTileDescriptor {
  return {
    ...input,
    grid: input.wide ? WIDE_GRID : CHART_GRID,
  };
}

export const INSIGHTS_TILES: TileDescriptor[] = [
  // Delivery & efficiency.
  kpiTile(
    InsightsSection.Delivery,
    InsightsKpiKey.Merged,
    "Merged PRs",
    "Pull requests"
  ),
  kpiTile(
    InsightsSection.Delivery,
    InsightsKpiKey.Ttm,
    "Median time to merge",
    "Time to merge"
  ),
  kpiTile(
    InsightsSection.Delivery,
    InsightsKpiKey.Kloc,
    "KLOC merged",
    "KLOC merged",
    "KLOC"
  ),
  kpiTile(InsightsSection.Delivery, InsightsKpiKey.Cost, "Cost"),
  kpiTile(InsightsSection.Delivery, InsightsKpiKey.MergeRate, "Merge rate"),
  kpiTile(
    InsightsSection.Delivery,
    InsightsKpiKey.PrSize,
    "Median PR size",
    "Median PR size",
    "lines"
  ),
  // ISS-5507: the KLOC trend's metric noun is surface-dependent (cloud sums
  // merged PRs, desktop sums captured ones), so all three variants carry a
  // `titleSuffix` and let the response name the metric — see
  // {@link ChartTileDescriptor.titleSuffix}.
  chartTile({
    id: "chart:klocTrend",
    section: InsightsSection.Delivery,
    title: "KLOC merged over time",
    titleSuffix: "over time",
    kind: TileKind.TimeSeries,
    dataKey: "klocTrend",
    metricKey: "kloc",
    metricLabel: "KLOC merged",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:klocTrend",
    wide: true,
  }),
  chartTile({
    id: "chart:klocTrend:bar",
    section: InsightsSection.Delivery,
    title: "KLOC merged by day",
    titleSuffix: "by day",
    kind: TileKind.TimeSeriesBar,
    dataKey: "klocTrend",
    metricKey: "kloc",
    metricLabel: "KLOC merged",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:klocTrend",
    wide: true,
  }),
  chartTile({
    id: "chart:klocTrend:heatmap",
    section: InsightsSection.Delivery,
    title: "KLOC merged heatmap",
    titleSuffix: "heatmap",
    kind: TileKind.Heatmap,
    dataKey: "klocTrend",
    metricKey: "kloc",
    metricLabel: "KLOC merged",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:klocTrend",
    wide: true,
  }),
  chartTile({
    id: "chart:prTrend",
    section: InsightsSection.Delivery,
    title: "PR throughput",
    kind: TileKind.TimeSeries,
    dataKey: "prTrend",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:prTrend",
    wide: true,
  }),
  chartTile({
    id: "chart:prTrend:heatmap",
    section: InsightsSection.Delivery,
    title: "PR activity heatmap",
    kind: TileKind.Heatmap,
    dataKey: "prTrend",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:prTrend",
    wide: true,
  }),
  chartTile({
    id: "chart:prTrend:bar",
    section: InsightsSection.Delivery,
    title: "PR throughput by day",
    kind: TileKind.TimeSeriesBar,
    dataKey: "prTrend",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:prTrend",
    wide: true,
  }),
  chartTile({
    id: "chart:prByRepo",
    section: InsightsSection.Delivery,
    title: "Merged PRs by repository",
    kind: TileKind.CategoryBar,
    dataKey: "prByRepo",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "repo", label: "Repository" },
    horizontal: true,
    infoKey: "chart:prByRepo",
  }),
  chartTile({
    id: "chart:prByRepo:donut",
    section: InsightsSection.Delivery,
    title: "PR share by repository",
    kind: TileKind.Donut,
    dataKey: "prByRepo",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "repo", label: "Repository" },
    infoKey: "chart:prByRepo",
  }),
  chartTile({
    id: "chart:prByState",
    section: InsightsSection.Delivery,
    title: "PR distribution",
    kind: TileKind.CategoryBar,
    dataKey: "prByState",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "state", label: "State" },
    infoKey: "chart:prByState",
  }),
  chartTile({
    id: "chart:prByState:donut",
    section: InsightsSection.Delivery,
    title: "PR distribution",
    kind: TileKind.Donut,
    dataKey: "prByState",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "state", label: "State" },
    infoKey: "chart:prByState",
  }),
  chartTile({
    id: "chart:checkStatus",
    section: InsightsSection.Delivery,
    title: "Check status",
    kind: TileKind.Donut,
    dataKey: "checkStatus",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "check-status", label: "Check status" },
    infoKey: "chart:checkStatus",
  }),
  chartTile({
    id: "chart:checkStatus:bar",
    section: InsightsSection.Delivery,
    title: "Check status",
    kind: TileKind.CategoryBar,
    dataKey: "checkStatus",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "check-status", label: "Check status" },
    infoKey: "chart:checkStatus",
  }),
  chartTile({
    id: "chart:branchesWithoutPr",
    section: InsightsSection.Delivery,
    title: "Branch coverage",
    kind: TileKind.CategoryBar,
    dataKey: "branchesWithoutPr",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "branch-coverage", label: "Branch coverage" },
    infoKey: "chart:branchesWithoutPr",
  }),
  chartTile({
    id: "chart:branchesWithoutPr:donut",
    section: InsightsSection.Delivery,
    title: "Branch coverage",
    kind: TileKind.Donut,
    dataKey: "branchesWithoutPr",
    metricKey: "merged",
    metricLabel: "Pull requests",
    groupBy: { key: "branch-coverage", label: "Branch coverage" },
    infoKey: "chart:branchesWithoutPr",
  }),
  chartTile({
    id: "chart:meanTimeToMerge",
    section: InsightsSection.Delivery,
    title: "Time to merge",
    kind: TileKind.CategoryBar,
    dataKey: "meanTimeToMerge",
    metricKey: "ttm",
    metricLabel: "Time to merge",
    groupBy: { key: "duration", label: "Duration bucket" },
    infoKey: "chart:meanTimeToMerge",
  }),
  chartTile({
    id: "chart:meanTimeToMerge:donut",
    section: InsightsSection.Delivery,
    title: "Time to merge",
    kind: TileKind.Donut,
    dataKey: "meanTimeToMerge",
    metricKey: "ttm",
    metricLabel: "Time to merge",
    groupBy: { key: "duration", label: "Duration bucket" },
    infoKey: "chart:meanTimeToMerge",
  }),
  chartTile({
    id: "chart:branchLifespan",
    section: InsightsSection.Delivery,
    title: "Branch lifespan",
    kind: TileKind.CategoryBar,
    dataKey: "branchLifespan",
    metricKey: "ttm",
    metricLabel: "Time to merge",
    groupBy: { key: "branch-age", label: "Branch age" },
    infoKey: "chart:branchLifespan",
  }),
  chartTile({
    id: "chart:branchLifespan:donut",
    section: InsightsSection.Delivery,
    title: "Branch lifespan",
    kind: TileKind.Donut,
    dataKey: "branchLifespan",
    metricKey: "ttm",
    metricLabel: "Time to merge",
    groupBy: { key: "branch-age", label: "Branch age" },
    infoKey: "chart:branchLifespan",
  }),

  // Utilization.
  kpiTile(InsightsSection.Utilization, InsightsKpiKey.Sessions, "Sessions"),
  kpiTile(InsightsSection.Utilization, InsightsKpiKey.Runtime, "Agent runtime"),
  kpiTile(
    InsightsSection.Utilization,
    InsightsKpiKey.Backlog,
    "Review backlog"
  ),
  kpiTile(InsightsSection.Utilization, InsightsKpiKey.Events, "Events"),
  chartTile({
    id: "chart:eventActivity",
    section: InsightsSection.Utilization,
    title: "Session activity",
    kind: TileKind.TimeSeries,
    dataKey: "eventActivity",
    metricKey: "sessions",
    metricLabel: "Sessions",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:eventActivity",
    wide: true,
  }),
  chartTile({
    id: "chart:eventActivity:heatmap",
    section: InsightsSection.Utilization,
    title: "Session activity heatmap",
    kind: TileKind.Heatmap,
    dataKey: "eventActivity",
    metricKey: "sessions",
    metricLabel: "Sessions",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:eventActivity",
    wide: true,
  }),
  chartTile({
    id: "chart:eventActivity:bar",
    section: InsightsSection.Utilization,
    title: "Sessions by day",
    kind: TileKind.TimeSeriesBar,
    dataKey: "eventActivity",
    metricKey: "sessions",
    metricLabel: "Sessions",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:eventActivity",
    wide: true,
  }),
  chartTile({
    id: "chart:eventVolume",
    section: InsightsSection.Utilization,
    title: "Events over time",
    kind: TileKind.TimeSeries,
    dataKey: "eventVolume",
    metricKey: "events",
    metricLabel: "Events",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:eventVolume",
    wide: true,
  }),
  chartTile({
    id: "chart:eventVolume:bar",
    section: InsightsSection.Utilization,
    title: "Events by day",
    kind: TileKind.TimeSeriesBar,
    dataKey: "eventVolume",
    metricKey: "events",
    metricLabel: "Events",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:eventVolume",
    wide: true,
  }),
  chartTile({
    id: "chart:eventVolume:heatmap",
    section: InsightsSection.Utilization,
    title: "Activity heatmap",
    kind: TileKind.Heatmap,
    dataKey: "eventVolume",
    metricKey: "events",
    metricLabel: "Events",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:eventVolume",
    wide: true,
  }),
  chartTile({
    id: "chart:eventsByType",
    section: InsightsSection.Utilization,
    title: "Events by type",
    kind: TileKind.Donut,
    dataKey: "eventsByType",
    metricKey: "events",
    metricLabel: "Events",
    groupBy: { key: "event-type", label: "Event type" },
    infoKey: "chart:eventsByType",
  }),
  chartTile({
    id: "chart:eventsByType:bar",
    section: InsightsSection.Utilization,
    title: "Events by type",
    kind: TileKind.CategoryBar,
    dataKey: "eventsByType",
    metricKey: "events",
    metricLabel: "Events",
    groupBy: { key: "event-type", label: "Event type" },
    horizontal: true,
    infoKey: "chart:eventsByType",
  }),
  chartTile({
    id: "chart:userBreakdown",
    section: InsightsSection.Utilization,
    title: "Sessions by operator",
    kind: TileKind.CategoryBar,
    dataKey: "userBreakdown",
    metricKey: "sessions",
    metricLabel: "Sessions",
    groupBy: { key: "operator", label: "Operator" },
    horizontal: true,
    infoKey: "chart:userBreakdown",
  }),
  chartTile({
    id: "chart:userBreakdown:donut",
    section: InsightsSection.Utilization,
    title: "Session share by operator",
    kind: TileKind.Donut,
    dataKey: "userBreakdown",
    metricKey: "sessions",
    metricLabel: "Sessions",
    groupBy: { key: "operator", label: "Operator" },
    infoKey: "chart:userBreakdown",
  }),
  chartTile({
    id: "chart:reviewQueue",
    section: InsightsSection.Utilization,
    title: "Review queue",
    kind: TileKind.CategoryBar,
    dataKey: "reviewQueue",
    metricKey: "backlog",
    metricLabel: "Review backlog",
    groupBy: { key: "queue-state", label: "Queue state" },
    infoKey: "chart:reviewQueue",
  }),
  chartTile({
    id: "chart:reviewQueue:donut",
    section: InsightsSection.Utilization,
    title: "Review queue",
    kind: TileKind.Donut,
    dataKey: "reviewQueue",
    metricKey: "backlog",
    metricLabel: "Review backlog",
    groupBy: { key: "queue-state", label: "Queue state" },
    infoKey: "chart:reviewQueue",
  }),
  chartTile({
    id: "chart:reviewerLoad",
    section: InsightsSection.Utilization,
    title: "Reviewer load",
    kind: TileKind.ReviewerTable,
    dataKey: "reviewerLoad",
    metricKey: "backlog",
    metricLabel: "Review backlog",
    groupBy: { key: "reviewer", label: "Reviewer" },
    infoKey: "chart:reviewerLoad",
  }),

  // Agents & tools.
  // ISS-5004 (review thread): the CARD names its basis too, not just the chart.
  // Retitling only the chart left the reconciliation one-sided — "All tokens by
  // class" reads as a contrast only if you already know the card above it
  // excludes cache, and nothing on the card said so (the info popover did, but
  // that is a click away). With both named, the pair reconciles on first read,
  // with "Cache saved" sitting between them as the difference.
  kpiTile(
    InsightsSection.Agents,
    InsightsKpiKey.Tokens,
    "Input + output tokens"
  ),
  kpiTile(InsightsSection.Agents, InsightsKpiKey.InputTokens, "Input tokens"),
  kpiTile(InsightsSection.Agents, InsightsKpiKey.OutputTokens, "Output tokens"),
  kpiTile(InsightsSection.Agents, InsightsKpiKey.CacheTokens, "Cache saved"),
  kpiTile(InsightsSection.Agents, InsightsKpiKey.Models, "Models in use"),
  kpiTile(InsightsSection.Agents, InsightsKpiKey.ToolRuns, "Tool runs"),
  // ISS-5004: titled for the population it actually decomposes, not "Token
  // distribution". Sitting under the "Tokens" KPI, the old title read as that
  // card's breakdown — but the card counts input + output while these slices add
  // cache read and write, so the chart's population ran far wider than the number
  // above it and neither said so. The card is the correct one (the desktop golden
  // oracle pins `input + output == kpi:tokens`), so the chart names its own basis
  // instead; the info copy reconciles the two explicitly.
  chartTile({
    id: "chart:tokenDistribution",
    section: InsightsSection.Agents,
    title: "All tokens by class",
    kind: TileKind.Donut,
    dataKey: "tokenDistribution",
    metricKey: "tokens",
    metricLabel: "Tokens",
    groupBy: { key: "token-type", label: "Token type" },
    infoKey: "chart:tokenDistribution",
  }),
  chartTile({
    id: "chart:tokenDistribution:bar",
    section: InsightsSection.Agents,
    // Same series, same basis — kept byte-identical to the donut's title so the
    // two renderings of one chart can't drift into naming different populations.
    title: "All tokens by class",
    kind: TileKind.CategoryBar,
    dataKey: "tokenDistribution",
    metricKey: "tokens",
    metricLabel: "Tokens",
    groupBy: { key: "token-type", label: "Token type" },
    infoKey: "chart:tokenDistribution",
  }),
  chartTile({
    id: "chart:toolUsage",
    section: InsightsSection.Agents,
    title: "Tool usage",
    kind: TileKind.CategoryBar,
    dataKey: "toolUsage",
    metricKey: "tool-runs",
    metricLabel: "Tool runs",
    groupBy: { key: "tool", label: "Tool" },
    horizontal: true,
    infoKey: "chart:toolUsage",
    wide: true,
  }),
  chartTile({
    id: "chart:toolUsage:donut",
    section: InsightsSection.Agents,
    title: "Tool usage share",
    kind: TileKind.Donut,
    dataKey: "toolUsage",
    metricKey: "tool-runs",
    metricLabel: "Tool runs",
    groupBy: { key: "tool", label: "Tool" },
    infoKey: "chart:toolUsage",
  }),
  chartTile({
    id: "chart:agentsByStatus",
    section: InsightsSection.Agents,
    title: "Agents by status",
    kind: TileKind.Donut,
    dataKey: "agentsByStatus",
    metricKey: "tool-runs",
    metricLabel: "Agents",
    groupBy: { key: "status", label: "Status" },
    infoKey: "chart:agentsByStatus",
  }),
  chartTile({
    id: "chart:agentsByStatus:bar",
    section: InsightsSection.Agents,
    title: "Agents by status",
    kind: TileKind.CategoryBar,
    dataKey: "agentsByStatus",
    metricKey: "tool-runs",
    metricLabel: "Agents",
    groupBy: { key: "status", label: "Status" },
    infoKey: "chart:agentsByStatus",
  }),
  chartTile({
    id: "chart:agentsByType",
    section: InsightsSection.Agents,
    title: "Agent type distribution",
    kind: TileKind.CategoryBar,
    dataKey: "agentsByType",
    metricKey: "tool-runs",
    metricLabel: "Agents",
    groupBy: { key: "agent-type", label: "Agent type" },
    horizontal: true,
    infoKey: "chart:agentsByType",
  }),
  chartTile({
    id: "chart:agentsByType:donut",
    section: InsightsSection.Agents,
    title: "Agent type share",
    kind: TileKind.Donut,
    dataKey: "agentsByType",
    metricKey: "tool-runs",
    metricLabel: "Agents",
    groupBy: { key: "agent-type", label: "Agent type" },
    infoKey: "chart:agentsByType",
  }),
  chartTile({
    id: "chart:toolRunsOverTime",
    section: InsightsSection.Agents,
    title: "Tool runs over time",
    kind: TileKind.TimeSeries,
    dataKey: "toolRunsOverTime",
    metricKey: "tool-runs",
    metricLabel: "Tool runs",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:toolRunsOverTime",
    wide: true,
  }),
  chartTile({
    id: "chart:toolRunsOverTime:bar",
    section: InsightsSection.Agents,
    title: "Tool runs by day",
    kind: TileKind.TimeSeriesBar,
    dataKey: "toolRunsOverTime",
    metricKey: "tool-runs",
    metricLabel: "Tool runs",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:toolRunsOverTime",
    wide: true,
  }),
  chartTile({
    id: "chart:toolRunsOverTime:heatmap",
    section: InsightsSection.Agents,
    title: "Tool runs heatmap",
    kind: TileKind.Heatmap,
    dataKey: "toolRunsOverTime",
    metricKey: "tool-runs",
    metricLabel: "Tool runs",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:toolRunsOverTime",
    wide: true,
  }),
  chartTile({
    id: "chart:modelUsageOverTime",
    section: InsightsSection.Agents,
    title: "Model cost over time",
    kind: TileKind.TimeSeries,
    dataKey: "modelUsageOverTime",
    metricKey: "cost",
    metricLabel: "Cost",
    groupBy: { key: "model", label: "Model" },
    infoKey: "chart:modelUsageOverTime",
    wide: true,
  }),
  chartTile({
    id: "chart:modelUsageOverTime:bar",
    section: InsightsSection.Agents,
    title: "Model cost by day",
    kind: TileKind.TimeSeriesBar,
    dataKey: "modelUsageOverTime",
    metricKey: "cost",
    metricLabel: "Cost",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:modelUsageOverTime",
    wide: true,
  }),
  chartTile({
    id: "chart:modelUsageOverTime:heatmap",
    section: InsightsSection.Agents,
    title: "Model cost heatmap",
    kind: TileKind.Heatmap,
    dataKey: "modelUsageOverTime",
    metricKey: "cost",
    metricLabel: "Cost",
    groupBy: { key: "date", label: "Date" },
    infoKey: "chart:modelUsageOverTime",
    wide: true,
  }),
  chartTile({
    id: "chart:modelBreakdown",
    section: InsightsSection.Agents,
    title: "Cost by model",
    kind: TileKind.CategoryBar,
    dataKey: "modelBreakdown",
    metricKey: "cost",
    metricLabel: "Cost",
    groupBy: { key: "model", label: "Model" },
    horizontal: true,
    showValueLabels: true,
    infoKey: "chart:modelBreakdown",
  }),
  chartTile({
    id: "chart:modelBreakdown:models",
    section: InsightsSection.Agents,
    title: "Models in use",
    kind: TileKind.CategoryBar,
    dataKey: "modelBreakdown",
    metricKey: "models",
    metricLabel: "Models in use",
    groupBy: { key: "model", label: "Model" },
    horizontal: true,
    infoKey: "chart:modelBreakdown",
  }),
  chartTile({
    id: "chart:modelBreakdown:donut",
    section: InsightsSection.Agents,
    title: "Cost share by model",
    kind: TileKind.Donut,
    dataKey: "modelBreakdown",
    metricKey: "cost",
    metricLabel: "Cost",
    groupBy: { key: "model", label: "Model" },
    infoKey: "chart:modelBreakdown",
  }),
  chartTile({
    id: "chart:modelBreakdown:models:donut",
    section: InsightsSection.Agents,
    title: "Models in use",
    kind: TileKind.Donut,
    dataKey: "modelBreakdown",
    metricKey: "models",
    metricLabel: "Models in use",
    groupBy: { key: "model", label: "Model" },
    infoKey: "chart:modelBreakdown",
  }),
  // ISS-4463 (TokenOps): spend split by the originating session's outcome.
  // Sits in Agents beside "Spend by model" because it reads the SAME spend
  // basis over the same window, so the two describe the same dollars.
  chartTile({
    id: "chart:spendByOutcome",
    section: InsightsSection.Agents,
    title: "Spend by session outcome",
    kind: TileKind.CategoryBar,
    dataKey: "spendByOutcome",
    metricKey: "cost",
    metricLabel: "Spend",
    groupBy: { key: "outcome", label: "Session outcome" },
    horizontal: true,
    showValueLabels: true,
    infoKey: "chart:spendByOutcome",
    featureFlag: INSIGHTS_SPEND_OUTCOME_FLAG_KEY,
    colorByKey: SPEND_OUTCOME_COLORS,
    zeroStateMessage: SPEND_OUTCOME_ZERO_MESSAGE,
  }),
  chartTile({
    id: "chart:spendByOutcome:donut",
    section: InsightsSection.Agents,
    title: "Spend share by session outcome",
    kind: TileKind.Donut,
    dataKey: "spendByOutcome",
    metricKey: "cost",
    metricLabel: "Spend",
    groupBy: { key: "outcome", label: "Session outcome" },
    infoKey: "chart:spendByOutcome",
    featureFlag: INSIGHTS_SPEND_OUTCOME_FLAG_KEY,
    colorByKey: SPEND_OUTCOME_COLORS,
    textureByKey: SPEND_OUTCOME_TEXTURES,
    textureMarkColorByKey: SPEND_OUTCOME_TEXTURE_MARK_COLORS,
    showSharePercent: true,
    zeroStateMessage: SPEND_OUTCOME_ZERO_MESSAGE,
  }),
];

/**
 * Narrows a catalog tile to a KPI tile, so a surface that renders KPI cards can
 * read the required `polarity` without a cast or an invented default.
 */
export function isKpiTile(tile: TileDescriptor): tile is KpiTileDescriptor {
  return tile.kind === TileKind.Kpi;
}

export function getSectionTiles(section: InsightsSection): TileDescriptor[] {
  return INSIGHTS_TILES.filter((tile) => tile.section === section);
}

export function getTile(id: string): TileDescriptor | undefined {
  return INSIGHTS_TILES.find((tile) => tile.id === id);
}

export const REMOVED_DASHBOARD_TILE_IDS = {
  SessionsByStatus: "chart:sessionsByStatus",
  SessionsByStatusBar: "chart:sessionsByStatus:bar",
} as const;

export const DEFAULT_DASHBOARD_TILE_IDS: string[] = [
  "kpi:tokens",
  "kpi:input-tokens",
  "kpi:output-tokens",
  "kpi:cache-tokens",
  "kpi:sessions",
  "kpi:events",
  "kpi:tool-runs",
  "kpi:merged",
  "chart:tokenDistribution",
  "chart:agentsByStatus",
  "chart:eventsByType",
  "chart:eventVolume:heatmap",
  "chart:agentsByType:donut",
  "chart:toolUsage:donut",
  "chart:modelBreakdown:donut",
  "chart:modelUsageOverTime",
  "chart:prTrend",
  "chart:prByRepo",
];

/**
 * Whether `tile` may be shown, given the caller's resolved flag state.
 *
 * An ungated tile is always enabled. A gated tile is enabled only when
 * `isFlagEnabled` returns true for its key — so it fails CLOSED under a caller
 * that cannot resolve flags (the ISS-4779 closed-by-default policy), rather than
 * leaking a dark-launched tile. Both reachable entry points (the metric picker's
 * add list and the dashboard grid's render list) filter through this one helper
 * so a gated tile can never be addable-but-unrenderable, or stay pinned on a
 * dashboard after its flag is turned back off.
 */
export function isTileEnabled(
  tile: TileDescriptor,
  isFlagEnabled: (key: string) => boolean
): boolean {
  return tile.featureFlag === undefined || isFlagEnabled(tile.featureFlag);
}
