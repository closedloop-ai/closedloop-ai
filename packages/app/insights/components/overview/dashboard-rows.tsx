import type { ActivityHeatmap, TimeSeries } from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { InsightsTile } from "@repo/app/insights/components/insights-tile";
import {
  type InsightsSectionData,
  selectKpi,
} from "@repo/app/insights/components/tile-content";
import { formatKpiValue } from "@repo/app/insights/lib/format";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
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
}: {
  row: DashboardRow;
  sections: InsightsSectionData;
  heatmap: ActivityHeatmap | undefined;
  modelSeries: TimeSeries | undefined;
  autonomySeries: TimeSeries | undefined;
  periodLabel?: string;
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
  return <TileRow row={row} sections={sections} />;
}

function TileRow({
  row,
  sections,
}: {
  row: DashboardRow;
  sections: InsightsSectionData;
}) {
  const tiles = resolveRowTiles(row);
  if (row.tour === "stats") {
    // KPI cards reuse the design-system MetricCard fed by the same insights
    // KpiStat data (selectKpi), rendering the delta chip + label + sub. Cards
    // size to content; the grid stretches them to even height (a fixed height
    // would clip the footer outside the border).
    return (
      <div className="grid grid-cols-2 items-stretch gap-3 lg:grid-cols-5">
        {tiles.map((tile) => {
          const kpi = selectKpi(tile, sections);
          return (
            <MetricCard
              className={DASHBOARD_METRIC_CARD_CLASS_NAME}
              delta={kpi?.deltaPct ?? "unknown"}
              deltaLabel="all time"
              detail={kpi?.sub}
              key={tile.id}
              label={tile.title}
              sparkline={kpiSparkline(tile.id, sections)}
              value={kpi ? formatKpiValue(kpi.value, kpi.format) : "—"}
            />
          );
        })}
      </div>
    );
  }
  // Two-up rows: models / prs lead with a wide chart (2/3) + a breakdown (1/3);
  // distribution is an even split. (The `activity` row never reaches here —
  // DashboardRowContent renders its heatmap and returns before TileRow.)
  const even = row.tour === "distribution";
  return (
    <div className={`grid gap-3 ${even ? "lg:grid-cols-2" : "lg:grid-cols-3"}`}>
      {tiles.map((tile, index) => (
        <div
          className={`h-[320px] ${!even && index === 0 ? "lg:col-span-2" : ""}`}
          key={tile.id}
        >
          <InsightsTile
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
