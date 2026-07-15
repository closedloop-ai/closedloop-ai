import type { ActivityHeatmap, TimeSeries } from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import {
  InsightsTile,
  renderTileAvailabilityOverride,
} from "@repo/app/insights/components/insights-tile";
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import {
  type InsightsSectionData,
  selectKpi,
} from "@repo/app/insights/components/tile-content";
import { formatKpiValue } from "@repo/app/insights/lib/format";
import type { InsightsTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { ReactNode } from "react";
import { AutonomyTrendChart } from "./autonomy-trend-chart";
import {
  DASHBOARD_METRIC_CARD_CLASS_NAME,
  DashboardCard,
} from "./dashboard-card";
import type { DASHBOARD_ROWS } from "./dashboard-tiles";
import { resolveRowTiles } from "./dashboard-tiles";
import { EventActivityHeatmap } from "./event-activity-heatmap";
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
    points: { values: Record<string, number> }[] | undefined,
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
    case "kpi:kloc":
      return values(
        sections[InsightsSection.Delivery]?.charts.klocTrend?.points,
        "kloc"
      );
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
  autonomySeries,
  periodLabel = "Last 90 days",
  deltaLabel = "all time",
  getTileAvailability,
  githubConnectHref,
  onConnectGitHub,
}: {
  row: DashboardRow;
  sections: InsightsSectionData;
  heatmap: ActivityHeatmap | undefined;
  modelSeries: TimeSeries | undefined;
  autonomySeries: TimeSeries | undefined;
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
}) {
  if (row.tour === "activity") {
    return (
      <DashboardCard>
        <EventActivityHeatmap heatmap={heatmap} periodLabel={periodLabel} />
      </DashboardCard>
    );
  }
  if (row.tour === "models") {
    return (
      <DashboardCard contentClassName="h-[340px]">
        <ModelUsageChart series={modelSeries} />
      </DashboardCard>
    );
  }
  if (row.tour === "autonomy") {
    return (
      <DashboardCard contentClassName="h-[300px]">
        <AutonomyTrendChart series={autonomySeries} />
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
        {tiles.map((tile) => {
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
  tile: TileDescriptor;
  sections: InsightsSectionData;
  deltaLabel: string;
}) {
  const kpi = selectKpi(tile, sections);
  const hasDelta = typeof kpi?.deltaPct === "number";
  return (
    <MetricCard
      className={DASHBOARD_METRIC_CARD_CLASS_NAME}
      delta={hasDelta ? (kpi?.deltaPct ?? undefined) : undefined}
      deltaLabel={hasDelta ? deltaLabel : undefined}
      info={kpi?.sub ? { what: kpi.sub } : undefined}
      label={kpi?.label || tile.title}
      sparkline={kpiSparkline(tile.id, sections)}
      trend={hasDelta ? undefined : <KpiDeltaPlaceholder />}
      unitLabel={kpi ? tile.unitLabel : undefined}
      value={kpi ? formatKpiValue(kpi.value, kpi.format) : "—"}
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
