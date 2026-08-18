import { isDeltaCapped } from "@closedloop-ai/loops-api/insights";
import type {
  ActivityHeatmap,
  AgentPipelineGraphData,
  KpiStat,
  TimeSeries,
} from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { AgentPipelineGraph } from "@repo/app/agents/components/agent-pipeline-graph";
import {
  COST_METRIC_CARD_LABEL,
  CostMetricCard,
  DASHBOARD_COST_METRIC_CARD_INFO,
} from "@repo/app/agents/components/sessions/cost-metric-card";
import {
  InsightsTile,
  renderTileAvailabilityOverride,
} from "@repo/app/insights/components/insights-tile";
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import {
  type InsightsSectionData,
  selectKpi,
} from "@repo/app/insights/components/tile-content";
import { formatKpiTileValue } from "@repo/app/insights/lib/format";
import { kpiNoComparisonReason } from "@repo/app/insights/lib/kpi-no-comparison-copy";
import type { InsightsTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type {
  KpiTileDescriptor,
  TileDescriptor,
} from "@repo/app/insights/lib/tile-catalog";
import { isKpiTile } from "@repo/app/insights/lib/tile-catalog";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { ReactNode } from "react";
import { AutonomyTrendChart } from "./autonomy-trend-chart";
import {
  DASHBOARD_METRIC_CARD_CLASS_NAME,
  DashboardCard,
} from "./dashboard-card";
import type { DASHBOARD_ROWS, DashboardRowGates } from "./dashboard-tiles";
import { resolveRowTiles } from "./dashboard-tiles";
import { EventActivityHeatmap } from "./event-activity-heatmap";
import { FrustrationTrendChart } from "./frustration-trend-chart";
import { ModelUsageChart } from "./model-usage-chart";

type DashboardRow = (typeof DASHBOARD_ROWS)[number];
type GetDashboardTileAvailability = (
  tile: TileDescriptor
) => InsightsTileAvailability;

// Recent daily values for a KPI's trend, used to draw the delta-chip sparkline.
// Only KPIs backed by a daily time series get one; others fall back to the icon.
function kpiSparkline(
  tileId: string,
  sections: InsightsSectionData
): number[] | undefined {
  const values = (
    points: { values: Record<string, number | null> }[] | undefined,
    key: string
  ) => points?.map((point) => point.values[key] ?? 0);
  switch (tileId) {
    case "kpi:sessions":
      return values(
        sections[InsightsSection.Utilization]?.charts.eventActivity.points,
        "sessions"
      );
    case "kpi:merged":
      return values(
        sections[InsightsSection.Delivery]?.charts.prTrend.points,
        "merged"
      );
    case "kpi:kloc": {
      // PLN-1535 M4: the KLOC tile reports `null` — the no-value glyph — when
      // NO merged PR in the window carries projected line counts. Drawing its
      // daily series underneath would put a flat line at zero directly below a
      // tile saying "we cannot size any merged PR": one claims nothing landed,
      // the other claims it cannot tell, and the chart is the more believable
      // of the two. The series buckets unsized PRs as absent, so every day is
      // 0 in exactly this case. No series, so the tile falls back to its icon.
      const kloc = sections[InsightsSection.Delivery]?.kpis.find(
        (stat) => stat.key === "kloc"
      );
      if (kloc?.value == null) {
        return undefined;
      }
      return values(
        sections[InsightsSection.Delivery]?.charts.klocTrend?.points,
        "kloc"
      );
    }
    default:
      return undefined;
  }
}

/**
 * Renders the content for a single overview dashboard row. Chart rows
 * (activity / models / autonomy) draw their dedicated chart inside a
 * `DashboardCard`; the rest fall through to `TileRow`, which lays out the
 * shared catalog tiles.
 */
export function DashboardRowContent({
  row,
  sections,
  heatmap,
  modelSeries,
  modelTokenSeries,
  autonomySeries,
  frustrationSeries,
  agentPipeline,
  periodLabel = "Last 90 days",
  deltaLabel = "all time",
  getTileAvailability,
  githubConnectHref,
  onConnectGitHub,
  gates,
}: {
  row: DashboardRow;
  sections: InsightsSectionData;
  heatmap: ActivityHeatmap | undefined;
  modelSeries: TimeSeries | undefined;
  // Token-volume counterpart to `modelSeries` for the Model Usage $/# toggle
  // (FEA-3497). Additive: older peers may omit it and the # view degrades gracefully.
  modelTokenSeries?: TimeSeries | undefined;
  autonomySeries: TimeSeries | undefined;
  // FEA-4022: normalized daily frustration trend. Additive + opt-in — only
  // rendered when the org enabled the setting and the API returns the series.
  frustrationSeries?: TimeSeries | undefined;
  // Aggregate agent-collaboration graph for the period (FEA-3537). Rendered in
  // the "agent-pipeline" row below the model-usage chart (empty-state when
  // there's no agent activity yet).
  agentPipeline?: AgentPipelineGraphData | undefined;
  periodLabel?: string;
  /**
   * Caption beside each KPI delta chip. Defaults to "all time"; the desktop
   * dashboard overrides it with the period-over-period label (WoW/MoM/QoQ) that
   * matches its selected range.
   */
  deltaLabel?: string;
  getTileAvailability?: GetDashboardTileAvailability;
  githubConnectHref?: string;
  onConnectGitHub?: () => void | Promise<void>;
  /**
   * ISS-5061: the closed-by-default row gates, passed in rather than read from
   * the flag port here so this component stays a pure renderer and BOTH shells
   * gate the row order and the render branch from the SAME resolved value —
   * they cannot disagree about whether a row exists.
   */
  gates: DashboardRowGates;
}) {
  if (row.tour === "activity") {
    // Intentionally no `fixedHeightClassName`: unlike the model/autonomy/pipeline
    // charts below (ResizeObserver-sized canvases that reflow to fill, FEA-3622),
    // the Event Activity heatmap is an INTRINSICALLY-sized grid of fixed-size day
    // cells. Filling a tall modal would only stretch the empty gaps around a
    // fixed grid, not enlarge the visualization, so it keeps its natural block
    // layout and default corner-expand affordance while its rowmates fill.
    return (
      <DashboardCard contentHasOwnTitle expandLabel="Event Activity">
        <EventActivityHeatmap heatmap={heatmap} periodLabel={periodLabel} />
      </DashboardCard>
    );
  }
  if (row.tour === "models") {
    return (
      <DashboardCard
        contentHasOwnTitle
        // Matches the chart's default ("cost") `SectionHeader` heading so the
        // modal's accessible name and its initial visible title agree (FEA-4016 /
        // WCAG 2.5.3). The heading swaps to "Model usage over time" with the
        // $/# toggle; the static dialog name stays on the canonical cost title.
        //
        // Sentence case, byte-identical to `MODEL_USAGE_PRESENTATION`'s cost
        // title and the tile catalog's entry for the same chart (review thread):
        // Title Case here left one chart named two ways between the grid and the
        // modal, against a catalog that is sentence case throughout.
        expandLabel="Model cost over time"
        fixedHeightClassName="h-[340px]"
      >
        <ModelUsageChart series={modelSeries} tokenSeries={modelTokenSeries} />
      </DashboardCard>
    );
  }
  if (row.tour === "agent-pipeline") {
    // ISS-5061 (ISS-4779 closed-by-default): the row is ABSENT when the gate is
    // off — deliberately `null`, not the graph's "No agent collaboration data"
    // empty state, which would tell the user there is no data when the feature
    // is simply off. Both shells already drop the row from their order via
    // `dashboardRowsFor`; this is the render-boundary half of the same gate, so
    // a caller that maps `DASHBOARD_ROWS` directly still cannot draw the card.
    if (!gates.agentCollaborationNetwork) {
      return null;
    }
    const nodes = agentPipeline?.nodes ?? [];
    const edges = agentPipeline?.edges ?? [];
    // `AgentPipelineGraph` always draws its own `SectionHeader` ("Agent
    // Collaboration Network") and renders the graph's own empty-state when there
    // are no nodes — so the header (and thus `contentHasOwnTitle`) holds on both
    // the populated and empty branches, and the empty grid card is no longer
    // anonymous. The expand label matches that visible heading (FEA-4016).
    return (
      <DashboardCard
        contentHasOwnTitle
        expandLabel="Agent Collaboration Network"
        fixedHeightClassName="h-[340px]"
      >
        <AgentPipelineGraph data={nodes} edges={edges} />
      </DashboardCard>
    );
  }
  if (row.tour === "autonomy") {
    return (
      <DashboardCard
        contentHasOwnTitle
        // Matches the chart's own visible `SectionHeader` heading so the modal's
        // accessible name and its visible title agree (FEA-4016 / WCAG 2.5.3).
        expandLabel="Autonomy Over Time"
        fixedHeightClassName="h-[300px]"
      >
        <AutonomyTrendChart series={autonomySeries} />
      </DashboardCard>
    );
  }
  if (row.tour === "frustration") {
    return (
      <DashboardCard
        expandLabel="Frustration Trend"
        fixedHeightClassName="h-[300px]"
      >
        <FrustrationTrendChart series={frustrationSeries} />
      </DashboardCard>
    );
  }
  return (
    <TileRow
      deltaLabel={deltaLabel}
      getTileAvailability={getTileAvailability}
      githubConnectHref={githubConnectHref}
      onConnectGitHub={onConnectGitHub}
      row={row}
      sections={sections}
    />
  );
}

function TileRow({
  row,
  sections,
  deltaLabel = "all time",
  getTileAvailability,
  githubConnectHref,
  onConnectGitHub,
}: {
  row: DashboardRow;
  sections: InsightsSectionData;
  deltaLabel?: string;
  getTileAvailability?: GetDashboardTileAvailability;
  githubConnectHref?: string;
  onConnectGitHub?: () => void | Promise<void>;
}) {
  const tiles = resolveRowTiles(row);
  if (row.tour === "stats") {
    // KPI cards reuse the design-system MetricCard fed by the same insights
    // KpiStat data (selectKpi), with descriptions tucked behind the card info
    // affordance. Cards size to content; the grid stretches them to even height
    // (a fixed height would clip the footer outside the border).
    return (
      <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {/* KPI tiles only — each carries the `polarity` the delta chip needs to
            colour a change honestly. `dashboard-tiles.test.ts` asserts the row's
            wired ids are all KPI tiles, so a mis-wired chart id fails in tests
            rather than silently vanishing here. */}
        {tiles.filter(isKpiTile).map((tile) => {
          const bodyOverride = renderTileAvailabilityOverride({
            availability: getTileAvailability?.(tile),
            githubConnectHref,
            onConnectGitHub,
          });
          return bodyOverride ? (
            <OverviewMetricOverride key={tile.id}>
              {bodyOverride}
            </OverviewMetricOverride>
          ) : (
            <OverviewKpiCard
              deltaLabel={deltaLabel}
              key={tile.id}
              sections={sections}
              tile={tile}
            />
          );
        })}
      </div>
    );
  }
  // Single chart rows span the full width. Two-up rows either lead with a wide
  // chart (2/3) + breakdown (1/3), or split evenly for the distribution row.
  // (The `activity` row never reaches here — DashboardRowContent renders its
  // heatmap and returns before TileRow.)
  const fullWidth = tiles.length === 1;
  const even = row.tour === "distribution";
  let gridColumnsClass = "";
  if (!fullWidth) {
    gridColumnsClass = even ? "lg:grid-cols-2" : "lg:grid-cols-3";
  }
  return (
    <div className={`grid min-w-0 gap-3 ${gridColumnsClass}`}>
      {tiles.map((tile, index) => (
        <div
          className={`h-[320px] min-w-0 ${
            !(fullWidth || even) && index === 0 ? "lg:col-span-2" : ""
          }`}
          key={tile.id}
        >
          <InsightsTile
            availability={getTileAvailability?.(tile)}
            githubConnectHref={githubConnectHref}
            onConnectGitHub={onConnectGitHub}
            pinned={false}
            sections={sections}
            tile={tile}
            variant="section"
          />
        </div>
      ))}
    </div>
  );
}

// A single overview KPI stat card. Reuses the design-system MetricCard fed by
// the same insights KpiStat data (selectKpi). A numeric delta renders the
// signed change chip (with deltaLabel + sparkline); when there's no prior-period
// comparison for the range (deltaPct null — e.g. the 90d/"all" ranges), the
// shared dash placeholder fills the delta slot instead of dropping it, matching
// the KpiMetricTile behavior so both KPI surfaces stay consistent.
function OverviewKpiCard({
  tile,
  sections,
  deltaLabel,
}: {
  tile: KpiTileDescriptor;
  sections: InsightsSectionData;
  deltaLabel: string;
}) {
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill
  // only when this surface's own gate is on — PostHog on web, Labs on desktop.
  const deltaTreatment = useMetricDeltaTreatment();
  const kpi = selectKpi(tile, sections);
  const hasDelta = typeof kpi?.deltaPct === "number";
  // FEA-3959: a delta AT the display ceiling renders the capped affordance
  // rather than an unbounded division artifact. ISS-5003: this build's
  // `pctDelta` declines past the ceiling instead of clamping to it, so what
  // still reaches here is a ±999 from a version-skewed producer — kept so those
  // peers render sanely rather than showing an unlabelled figure.
  const deltaCapped = hasDelta && isDeltaCapped(kpi?.deltaPct ?? null);
  // The Cost KPI renders the shared CostMetricCard (extracted below so this
  // dispatcher stays under the cognitive-complexity ceiling).
  if (tile.id === "kpi:cost") {
    return (
      <OverviewCostKpiCard
        deltaCapped={deltaCapped}
        deltaLabel={deltaLabel}
        hasDelta={hasDelta}
        kpi={kpi}
        sparkline={kpiSparkline(tile.id, sections)}
      />
    );
  }
  const deltaValue = hasDelta ? (kpi?.deltaPct ?? undefined) : undefined;
  const commonProps = {
    className: DASHBOARD_METRIC_CARD_CLASS_NAME,
    info: kpi?.sub ? { what: kpi.sub } : undefined,
    label: kpi?.label || tile.title,
    sparkline: kpiSparkline(tile.id, sections),
    unitLabel: kpi ? tile.unitLabel : undefined,
    value: kpi ? formatKpiTileValue(kpi.value, kpi.format) : "—",
  };
  // `delta`/`deltaPolarity` are a paired union on MetricCard (wongk review on
  // #4148): pass the metric's polarity only alongside a real number so a KPI
  // without a comparison renders the "No comparison" placeholder, never a
  // defaulted green-rise chip. ISS-4633: the polarity is the tile's own, so a
  // lower-is-better KPI's rise reads as a regression, not the throughput colour.
  if (deltaValue === undefined) {
    return (
      <MetricCard
        {...commonProps}
        deltaPlaceholder={
          // ISS-4995: the producer says whether it computes a comparison for
          // this metric at all, so a metric we never compare (cloud's `kloc` /
          // `pr-size`) stops borrowing the range-based sentence and blaming the
          // reader's history for a gap on our side.
          <KpiDeltaPlaceholder
            reason={kpiNoComparisonReason(kpi?.deltaBasis)}
          />
        }
      />
    );
  }
  return (
    <MetricCard
      {...commonProps}
      delta={deltaValue}
      deltaCapped={deltaCapped}
      deltaLabel={deltaLabel}
      deltaPolarity={tile.polarity}
      deltaTreatment={deltaTreatment}
    />
  );
}

function OverviewMetricOverride({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${DASHBOARD_METRIC_CARD_CLASS_NAME} grid min-h-[132px] rounded-lg border bg-card`}
    >
      {children}
    </div>
  );
}

// FEA-3818: the Cost KPI renders the shared CostMetricCard — the SAME component
// the Sessions summary row uses — so the two surfaces can't drift on formatting,
// the honest-empty `—`, or the delta chip. On THIS surface the card is fed the
// same single-line `kpi.sub` info its four rowmates (and the Insights stat tile)
// render, so the whole Dashboard row shares one voice and one tooltip height.
// The detail line is omitted: this surface's value is the full
// subscription-inclusive aggregate with no separate metered split to caption.
// FEA-3960/3961: the "no comparison" affordance fills the SAME delta slot the
// numeric chip would (via `deltaPlaceholder`), not the separate `trend` corner,
// so the delta info doesn't jump position between cards with and without a
// comparison in a five-card row. Extracted from `OverviewKpiCard` so that
// dispatcher stays under the cognitive-complexity ceiling (ISS-4401).
function OverviewCostKpiCard({
  kpi,
  hasDelta,
  deltaCapped,
  deltaLabel,
  sparkline,
}: {
  kpi: KpiStat | undefined;
  hasDelta: boolean;
  deltaCapped: boolean;
  deltaLabel: string;
  sparkline: number[] | undefined;
}) {
  return (
    <CostMetricCard
      className={DASHBOARD_METRIC_CARD_CLASS_NAME}
      cost={kpi?.value}
      delta={hasDelta ? (kpi?.deltaPct ?? undefined) : undefined}
      deltaCapped={deltaCapped}
      deltaLabel={hasDelta ? deltaLabel : undefined}
      deltaPlaceholder={
        hasDelta ? undefined : (
          <KpiDeltaPlaceholder
            reason={kpiNoComparisonReason(kpi?.deltaBasis)}
          />
        )
      }
      // wongk review on #4905: fall back to THIS surface's copy, not the
      // component's default. That default is the Sessions copy, and Sessions
      // always passes `info` explicitly, so an `undefined` here was the only
      // production path that reached it — handing the Dashboard a tooltip about
      // "filtered sessions" and a caption beneath the number this surface never
      // renders. Mirrors the `label` fallback directly below.
      info={kpi?.sub ? { what: kpi.sub } : DASHBOARD_COST_METRIC_CARD_INFO}
      // ISS-4401: source the label from the backend `kpi.label` like the four
      // rowmates, falling back to the canonical "Cost" default rather than
      // letting this one tile diverge if the backend renames the KPI.
      label={kpi?.label ?? COST_METRIC_CARD_LABEL}
      sparkline={sparkline}
    />
  );
}
