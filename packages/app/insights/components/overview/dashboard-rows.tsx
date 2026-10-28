import { isDeltaCapped } from "@closedloop-ai/loops-api/insights";
import type {
  ActivityHeatmap,
  AgentPipelineGraphData,
  TimeSeries,
} from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY } from "@repo/api/src/types/insights-loc-terminology-flag";
import { AgentPipelineGraph } from "@repo/app/agents/components/agent-pipeline-graph";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import {
  InsightsTile,
  renderTileAvailabilityDetail,
} from "@repo/app/insights/components/insights-tile";
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import { isKpiValueAbsent } from "@repo/app/insights/components/kpi-stat-tile";
import {
  type InsightsSectionData,
  selectKpi,
} from "@repo/app/insights/components/tile-content";
import { formatKpiTileValue } from "@repo/app/insights/lib/format";
import { kpiNoComparisonReason } from "@repo/app/insights/lib/kpi-no-comparison-copy";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import type { InsightsTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type {
  KpiTileDescriptor,
  TileDescriptor,
} from "@repo/app/insights/lib/tile-catalog";
import {
  isKpiTile,
  resolveTileVocabulary,
} from "@repo/app/insights/lib/tile-catalog";
import { SUMMARY_CARD_LABEL_ROW_BASELINE_CLASS } from "@repo/app/shared/components/summary-card-row";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMetricCardHideUnavailable } from "@repo/app/shared/feature-flags/use-metric-card-hide-unavailable";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { hiddenMetricCardIds } from "@repo/app/shared/lib/metric-card-hide-policy";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { cn } from "@repo/design-system/lib/utils";
import { type ReactNode, useMemo } from "react";
import { AutonomyTrendChart } from "./autonomy-trend-chart";
import {
  DASHBOARD_METRIC_CARD_CLASS_NAME,
  DashboardCard,
} from "./dashboard-card";
import {
  DashboardRowUpdatingNotice,
  STALE_DELTA_LABEL,
  STALE_PERIOD_LABEL,
  useDebouncedVisibility,
} from "./dashboard-refreshing";
import type { DASHBOARD_ROWS, DashboardRowGates } from "./dashboard-tiles";
import { resolveRowTiles } from "./dashboard-tiles";
import { EventActivityHeatmap } from "./event-activity-heatmap";
import { FrustrationTrendChart } from "./frustration-trend-chart";
import { ModelUsageChart } from "./model-usage-chart";
import { OverviewCostKpiCard } from "./overview-cost-kpi-card";

type DashboardRow = (typeof DASHBOARD_ROWS)[number];
type GetDashboardTileAvailability = (
  tile: TileDescriptor
) => InsightsTileAvailability;

// Recent daily values for a KPI's trend, used to draw the delta-chip sparkline.
// Only KPIs backed by a daily time series get one; others fall back to the icon.
/**
 * The daily series each volume KPI's sparkline is taken of. Keyed by the KPI key
 * the tile actually reads, so the KLOC and LOC vocabularies each draw their own.
 */
const VOLUME_TREND_BY_KPI_KEY: Readonly<
  Record<string, { chart: "klocTrend" | "locTrend"; series: string }>
> = {
  [InsightsKpiKey.Kloc]: { chart: "klocTrend", series: "kloc" },
  [InsightsKpiKey.Loc]: { chart: "locTrend", series: "loc" },
};

function kpiSparkline(
  tileId: string,
  dataKey: string,
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
      // PLN-1535 M4: the volume tile reports `null` — the no-value glyph — when
      // NO merged PR in the window carries projected line counts. Drawing its
      // daily series underneath would put a flat line at zero directly below a
      // tile saying "we cannot size any merged PR": one claims nothing landed,
      // the other claims it cannot tell, and the chart is the more believable
      // of the two. The series buckets unsized PRs as absent, so every day is
      // 0 in exactly this case. No series, so the tile falls back to its icon.
      //
      // ISS-8184: keyed off the RESOLVED `dataKey` rather than the flag, so the
      // sparkline is taken of the same operand the headline above it states —
      // the two cannot disagree about which vocabulary is on screen.
      const trend = VOLUME_TREND_BY_KPI_KEY[dataKey];
      if (trend === undefined) {
        return undefined;
      }
      const volume = sections[InsightsSection.Delivery]?.kpis.find(
        (stat) => stat.key === dataKey
      );
      if (volume?.value == null) {
        return undefined;
      }
      return values(
        sections[InsightsSection.Delivery]?.charts[trend.chart]?.points,
        trend.series
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
 *
 * ISS-10414: when `stale`, the row is drawing the PREVIOUS range/scope's payload
 * (a section serving `keepPreviousData`), so every widget in it carries
 * {@link DashboardRowUpdatingNotice} INSIDE its own card — the subtree that
 * relocates into the expand dialog — and no widget may label itself with the
 * SELECTED period or the SELECTED comparison window; see `windowLabel` and
 * `comparisonLabel` in the body below.
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
  githubConnect,
  gates,
  stale = false,
}: DashboardRowContentProps) {
  // ISS-10414: "Last 7 days · hourly turn density" over a ninety-day grid was
  // the filed contradiction — the caption asserted the SELECTION while the cells
  // were the previous window. While the section is stale neither range caption
  // asserts a window; the notice beside them says why. `deltaLabel` is the
  // SECOND such claim and is derived from the same picker, so it is neutralized
  // with it (review thread): a ninety-day KPI chip captioned "vs. prior 7 days"
  // is the identical contradiction one widget over.
  // Debounced ONCE, here, so the chip, the period caption and the delta caption
  // move together. Review thread, 2026-09-17: every section is keyed on the same
  // `period:scope` and refetches together, so an undebounced flip chipped every
  // row on the first frames after each range click, swapped its captions, grew
  // its fixed-band card by the chip row, and undid all three the moment the
  // fast sections landed — ten copies of one sentence, which is the shape
  // FEA-4020 rejects. Only a section still behind at the onset discloses.
  const disclosed = useDebouncedVisibility(stale);
  const windowLabel = disclosed ? STALE_PERIOD_LABEL : periodLabel;
  const comparisonLabel = disclosed ? STALE_DELTA_LABEL : deltaLabel;
  return renderDashboardRowBody({
    agentPipeline,
    autonomySeries,
    deltaLabel: comparisonLabel,
    frustrationSeries,
    gates,
    getTileAvailability,
    githubConnect,
    heatmap,
    modelSeries,
    modelTokenSeries,
    row,
    sections,
    stale: disclosed,
    windowLabel,
  });
}

/**
 * ISS-10414: the row's disclosure, placed so it CANNOT be left behind.
 *
 * It used to wrap the row from outside. Every dashboard widget relocates into
 * the fullscreen dialog as a single portaled subtree (`ExpandableWidget`), and
 * a wrapper is not in that subtree — so expanding a stale chart showed the
 * previous range's data in a modal with no disclosure at all (review thread).
 * Rendering it INSIDE each widget's own card puts it in the subtree that
 * travels, so the modal discloses exactly what the grid did.
 *
 * Rendered UNCONDITIONALLY (review thread, 2026-09-17): guarding here left
 * `DashboardRowUpdatingNotice`'s own `stale` branch unreachable, and — worse —
 * inserted its live region into the DOM with the text already inside it, which
 * screen readers routinely do not announce, while the clearance was never
 * announced at all because the node unmounted. The component now owns both
 * halves; its visible chip is still what mounts and unmounts, so a settled
 * dashboard carries no extra chrome.
 *
 * `gutterClassName` is the HOST's horizontal gutter. It moved onto the notice
 * because the hosts used to wrap it in a padded `<div>` that only existed when
 * the notice did — an always-mounted notice would have made that wrapper a
 * permanent flex child and cost every settled card a row of the card's `gap-6`.
 */
function rowNotice(stale: boolean, gutterClassName?: string): ReactNode {
  return (
    <DashboardRowUpdatingNotice className={gutterClassName} stale={stale} />
  );
}

type DashboardRowContentProps = {
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
  githubConnect?: GitHubConnectTarget;
  /**
   * ISS-5061: the closed-by-default row gates, passed in rather than read from
   * the flag port here so this component stays a pure renderer and BOTH shells
   * gate the row order and the render branch from the SAME resolved value —
   * they cannot disagree about whether a row exists.
   */
  gates: DashboardRowGates;
  /**
   * ISS-10414: is this row drawing the PREVIOUS range/scope's payload? True
   * while a section it reads from is serving `keepPreviousData` for a key the
   * reader has already moved off. Defaults to false, so a caller that does not
   * yet thread it renders exactly as before.
   */
  stale?: boolean;
};

function renderDashboardRowBody({
  row,
  sections,
  heatmap,
  modelSeries,
  modelTokenSeries,
  autonomySeries,
  frustrationSeries,
  agentPipeline,
  windowLabel,
  deltaLabel,
  getTileAvailability,
  githubConnect,
  gates,
  stale,
}: Omit<DashboardRowContentProps, "periodLabel" | "stale"> & {
  deltaLabel: string;
  /** The period caption the widgets may actually claim — see the caller. */
  windowLabel: string;
  stale: boolean;
}) {
  // DashboardCard's own gutter; TileRow takes the InsightsTile section gutter.
  const notice = rowNotice(stale, CARD_GUTTER_CLASS);
  if (row.tour === "activity") {
    // Intentionally no `fixedHeightClassName`: unlike the model/autonomy/pipeline
    // charts below (ResizeObserver-sized canvases that reflow to fill, FEA-3622),
    // the Event Activity heatmap is an INTRINSICALLY-sized grid of fixed-size day
    // cells. Filling a tall modal would only stretch the empty gaps around a
    // fixed grid, not enlarge the visualization, so it keeps its natural block
    // layout and default corner-expand affordance while its rowmates fill.
    return (
      <DashboardCard
        contentHasOwnTitle
        expandLabel="Event Activity"
        notice={notice}
      >
        <EventActivityHeatmap heatmap={heatmap} periodLabel={windowLabel} />
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
        notice={notice}
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
        notice={notice}
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
        notice={notice}
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
        notice={notice}
      >
        <FrustrationTrendChart series={frustrationSeries} />
      </DashboardCard>
    );
  }
  return (
    <TileRow
      deltaLabel={deltaLabel}
      getTileAvailability={getTileAvailability}
      githubConnect={githubConnect}
      row={row}
      sections={sections}
      stale={stale}
    />
  );
}

function TileRow({
  row,
  sections,
  deltaLabel = "all time",
  getTileAvailability,
  githubConnect,
  stale,
}: {
  row: DashboardRow;
  sections: InsightsSectionData;
  deltaLabel?: string;
  getTileAvailability?: GetDashboardTileAvailability;
  githubConnect?: GitHubConnectTarget;
  /**
   * ISS-10414: is this row drawing the PREVIOUS range/scope's payload? The KPI
   * row's cards do not expand, so the disclosure is stated once above that grid;
   * every CHART tile does expand, so it is rendered INSIDE the card that
   * relocates into the dialog (review thread).
   */
  stale: boolean;
}) {
  const locTerminologyEnabled = useFeatureFlagEnabledOptional(
    INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY
  );
  const tiles = useMemo(
    () =>
      resolveRowTiles(row).map((tile) =>
        resolveTileVocabulary(
          tile,
          (key) =>
            key === INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY && locTerminologyEnabled
        )
      ),
    [row, locTerminologyEnabled]
  );
  if (row.tour === "stats") {
    // No card gutter: this row's notice sits above the KPI grid, not inside a card.
    const notice = rowNotice(stale);
    const kpiGrid = (
      <StatsKpiRow
        deltaLabel={deltaLabel}
        getTileAvailability={getTileAvailability}
        githubConnect={githubConnect}
        sections={sections}
        tiles={tiles}
      />
    );
    // The notice's always-mounted half is `sr-only` (absolutely positioned), so
    // it is not an in-flow flex child and this wrapper's `gap-2` still applies
    // only between the visible chip and the grid.
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {notice}
        {kpiGrid}
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
            githubConnect={githubConnect}
            // One statement per ROW, not per tile: the `distribution` row draws
            // two tiles and handing each the same notice put two identical
            // "Updating" chips side by side (review thread, 2026-09-17).
            notice={index === 0 ? rowNotice(stale, TILE_GUTTER_CLASS) : null}
            pinned={false}
            sections={sections}
            tile={tile}
            variant="section"
            withSupportingCopy
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
  hidden,
}: {
  tile: KpiTileDescriptor;
  sections: InsightsSectionData;
  deltaLabel: string;
  /** Did the row's `metric-card-hide-unavailable` pass retire this card? */
  hidden: boolean;
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
        hidden={hidden}
        kpi={kpi}
        sparkline={kpiSparkline(tile.id, tile.dataKey, sections)}
      />
    );
  }
  // The four non-Cost cards spell their absence as the pre-formatted `"—"`
  // string below, which leaves `MetricCard`'s own `noData` false — so the
  // primitive's `hideWhenUnavailable` cannot see it and the retirement has to
  // happen here. Gate off, `hidden` is never true and the card is unchanged.
  if (hidden) {
    return null;
  }
  const deltaValue = hasDelta ? (kpi?.deltaPct ?? undefined) : undefined;
  const commonProps = {
    className: DASHBOARD_METRIC_CARD_CLASS_NAME,
    info: kpi?.sub ? { what: kpi.sub } : undefined,
    label: tile.title,
    sparkline: kpiSparkline(tile.id, tile.dataKey, sections),
    unitLabel: kpi ? tile.unitLabel : undefined,
    value: kpi ? formatKpiTileValue(kpi.value, kpi.format) : "—",
  };
  // `delta`/`deltaPolarity` are a paired union on MetricCard (whitlockk review on
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

/**
 * A headline KPI that cannot state its value: gated behind a GitHub connection,
 * or unavailable for the scope.
 *
 * ISS-7866: this used to render the affordance in a bare bordered box, which
 * dropped the metric's LABEL — signed out, the row showed an unnamed card with
 * a bare connect control and nothing saying it was Merged PRs. It is a
 * `MetricCard` like its four rowmates now, so the name survives and the value
 * slot is honestly empty (`null` → the muted "No data" glyph) rather than a
 * fabricated figure. Same shape the Branches list card rendered for its own
 * gated cards until ISS-9961 removed that row; the affordance itself is the
 * shared `ConnectGitHubIndicator` Card variant, which both surfaces still use.
 *
 * ISS-9749 ruled this row OUT of `metric-card-hide-unavailable` for that reason:
 * this is the row's only `null` value and it exists to carry an ASK, so hiding
 * it would delete both the affordance and the metric's name. The sibling
 * `OverviewKpiCard` is out for a different reason — it spells its absence as a
 * literal `"—"` string, which is never a `noData` state to the primitive, so
 * the gate would be inert there without first migrating it to `value={null}`.
 */
function OverviewMetricOverride({
  detail,
  title,
}: {
  detail: ReactNode;
  title: string;
}) {
  return (
    <MetricCard
      className={`${DASHBOARD_METRIC_CARD_CLASS_NAME} min-h-[132px]`}
      detail={detail}
      // ISS-7866 review: NOT the producer's label or its `sub`. A gated card is
      // offering the metric the catalog names, and the producer speaking here is
      // the LOCAL one — which after ISS-7868 sends "Median captured PR size" and
      // a captured-population caption. Labelling the ask with the population it
      // is declining to report tells the reader that connecting GitHub will
      // light up a local-capture median, which is the opposite of true.
      label={title}
      value={null}
    />
  );
}

/**
 * The headline KPI row.
 *
 * KPI cards reuse the design-system MetricCard fed by the same insights KpiStat
 * data (selectKpi), with descriptions tucked behind the card info affordance.
 * Cards size to content; the grid stretches them to even height (a fixed height
 * would clip the footer outside the border).
 *
 * ISS-9749 (ISS-4779 closed-by-default) wires the row onto ISS-9730's gate. The
 * absence it retires is settled by the time this row exists at all: a loading or
 * failed row draws its own skeleton or degraded card in `DashboardRowSlot`
 * instead of this content (ISS-10486; on the desktop shell an errored section
 * still short-circuits the whole page), so nothing reaching here is either. What is left is
 * a producer that sent no KPI for the tile, or one whose figure is nullish —
 * the same fact stated two ways. A gated card keeps its ask (see
 * {@link OverviewMetricOverride}) and a real `0` keeps its figure.
 *
 * The row's own track counts are FIXED (`grid-cols-1` / `lg:grid-cols-3` /
 * `xl:grid-cols-5`), never one `1fr` per surviving card, so survivors keep the
 * exact width they have today and a thinned row ends short instead of inflating
 * into the gap. That is why no partial-strip card width is composed here.
 */
function StatsKpiRow({
  tiles,
  sections,
  deltaLabel,
  getTileAvailability,
  githubConnect,
}: {
  tiles: TileDescriptor[];
  sections: InsightsSectionData;
  deltaLabel: string;
  getTileAvailability?: GetDashboardTileAvailability;
  githubConnect?: GitHubConnectTarget;
}) {
  const hideUnavailable = useMetricCardHideUnavailable();
  // KPI tiles only — each carries the `polarity` the delta chip needs to colour
  // a change honestly. `dashboard-tiles.test.ts` asserts the row's wired ids are
  // all KPI tiles, so a mis-wired chart id fails in tests rather than silently
  // vanishing here.
  const cards = tiles.filter(isKpiTile).map((tile) => {
    const availabilityDetail = renderTileAvailabilityDetail({
      availability: getTileAvailability?.(tile),
      githubConnect,
      // ISS-11476 scopes the prototype's supporting sentence to the dashboard's
      // metric cards, which is this row.
      withSupportingCopy: true,
    });
    return {
      availabilityDetail,
      id: tile.id,
      notComputable:
        !availabilityDetail &&
        isKpiValueAbsent(selectKpi(tile, sections)?.value),
      tile,
    };
  });
  const hidden = hiddenMetricCardIds({ cards, enabled: hideUnavailable });
  return (
    <div
      className={cn(
        "grid grid-cols-1 items-stretch gap-3 lg:grid-cols-3 xl:grid-cols-5",
        // ISS-9971: the canonical dollar label wraps to two lines where its four
        // rowmates take one, which drops that card's figure off the row's shared
        // baseline. The Sessions strip floors every label region through
        // `SummaryCardRow`; this row is a bare grid, so it takes the same floor.
        SUMMARY_CARD_LABEL_ROW_BASELINE_CLASS
      )}
    >
      {cards.map((card) => {
        if (card.availabilityDetail) {
          return (
            <OverviewMetricOverride
              detail={card.availabilityDetail}
              key={card.id}
              title={card.tile.title}
            />
          );
        }
        return (
          <OverviewKpiCard
            deltaLabel={deltaLabel}
            hidden={hidden.has(card.id)}
            key={card.id}
            sections={sections}
            tile={card.tile}
          />
        );
      })}
    </div>
  );
}

/** `DashboardCard`'s horizontal gutter, so a notice inside one lines up with its header and content. */
const CARD_GUTTER_CLASS = "px-4 sm:px-6";

/** `InsightsTile`'s `variant="section"` gutter — the only variant a dashboard row renders. */
const TILE_GUTTER_CLASS = "px-6";
