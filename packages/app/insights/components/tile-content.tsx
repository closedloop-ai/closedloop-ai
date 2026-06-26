"use client";

import type {
  AgentsInsightsResponse,
  CategoryBucket,
  DeliveryInsightsResponse,
  KpiStat,
  TimeSeries,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import { DonutChart } from "@repo/design-system/components/ui/donut-chart";
import { ActivityHeatmap } from "@repo/design-system/components/ui/primitives/activity-heatmap";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { type ReactNode, useMemo } from "react";
import { type TileDescriptor, TileKind } from "../lib/tile-catalog";
import { ReviewerTable } from "./reviewer-table";

export type InsightsSectionData = {
  [InsightsSection.Delivery]?: DeliveryInsightsResponse;
  [InsightsSection.Utilization]?: UtilizationInsightsResponse;
  [InsightsSection.Agents]?: AgentsInsightsResponse;
};

const LOCAL_DATA_UNAVAILABLE = "No data yet";

export function selectKpi(
  tile: TileDescriptor,
  sections: InsightsSectionData
): KpiStat | undefined {
  const response = sections[tile.section];
  return response?.kpis.find((entry) => entry.key === tile.dataKey);
}

export function InsightsChartContent({
  tile,
  sections,
  comparisonSections,
  comparisonLabel,
}: {
  tile: TileDescriptor;
  sections: InsightsSectionData;
  comparisonSections?: InsightsSectionData;
  comparisonLabel?: string;
}): ReactNode {
  if (tile.section === InsightsSection.Delivery) {
    const response = sections[InsightsSection.Delivery];
    return response ? (
      renderDelivery(
        tile,
        response,
        comparisonSections?.[InsightsSection.Delivery],
        comparisonLabel
      )
    ) : (
      <Skeleton className="h-full w-full" />
    );
  }
  if (tile.section === InsightsSection.Utilization) {
    const response = sections[InsightsSection.Utilization];
    return response ? (
      renderUtilization(
        tile,
        response,
        comparisonSections?.[InsightsSection.Utilization],
        comparisonLabel
      )
    ) : (
      <Skeleton className="h-full w-full" />
    );
  }
  const response = sections[InsightsSection.Agents];
  return response ? (
    renderAgents(
      tile,
      response,
      comparisonSections?.[InsightsSection.Agents],
      comparisonLabel
    )
  ) : (
    <Skeleton className="h-full w-full" />
  );
}

function renderDelivery(
  tile: TileDescriptor,
  response: DeliveryInsightsResponse,
  comparison: DeliveryInsightsResponse | undefined,
  comparisonLabel: string | undefined
): ReactNode {
  if (tile.kind === TileKind.TimeSeries) {
    return renderTimeSeries(
      getDeliveryTimeSeries(tile.dataKey, response),
      comparison ? getDeliveryTimeSeries(tile.dataKey, comparison) : undefined,
      comparisonLabel
    );
  }
  if (tile.kind === TileKind.TimeSeriesBar) {
    return renderTimeSeriesBar(getDeliveryTimeSeries(tile.dataKey, response));
  }
  if (tile.kind === TileKind.Heatmap) {
    return renderHeatmap(getDeliveryTimeSeries(tile.dataKey, response));
  }

  return renderCategory(
    tile,
    getDeliveryCategory(tile.dataKey, response.charts)
  );
}

function renderUtilization(
  tile: TileDescriptor,
  response: UtilizationInsightsResponse,
  comparison: UtilizationInsightsResponse | undefined,
  comparisonLabel: string | undefined
): ReactNode {
  if (tile.kind === TileKind.TimeSeries) {
    return renderTimeSeries(
      getUtilizationTimeSeries(tile.dataKey, response),
      comparison
        ? getUtilizationTimeSeries(tile.dataKey, comparison)
        : undefined,
      comparisonLabel
    );
  }
  if (tile.kind === TileKind.TimeSeriesBar) {
    return renderTimeSeriesBar(
      getUtilizationTimeSeries(tile.dataKey, response)
    );
  }
  if (tile.kind === TileKind.Heatmap) {
    return renderHeatmap(getUtilizationTimeSeries(tile.dataKey, response));
  }
  if (tile.kind === TileKind.ReviewerTable) {
    return response.charts.reviewerLoad ? (
      <ReviewerTable rows={response.charts.reviewerLoad} />
    ) : (
      <ChartEmpty message={LOCAL_DATA_UNAVAILABLE} />
    );
  }

  return renderCategory(
    tile,
    getUtilizationCategory(tile.dataKey, response.charts)
  );
}

function renderAgents(
  tile: TileDescriptor,
  response: AgentsInsightsResponse,
  comparison: AgentsInsightsResponse | undefined,
  comparisonLabel: string | undefined
): ReactNode {
  if (tile.kind === TileKind.TimeSeries) {
    return renderTimeSeries(
      getAgentsTimeSeries(tile.dataKey, response),
      comparison ? getAgentsTimeSeries(tile.dataKey, comparison) : undefined,
      comparisonLabel
    );
  }
  if (tile.kind === TileKind.TimeSeriesBar) {
    return renderTimeSeriesBar(getAgentsTimeSeries(tile.dataKey, response));
  }
  if (tile.kind === TileKind.Heatmap) {
    return renderHeatmap(getAgentsTimeSeries(tile.dataKey, response));
  }

  return renderCategory(tile, getAgentsCategory(tile.dataKey, response.charts));
}

function renderTimeSeries(
  chart: TimeSeries | undefined,
  comparison: TimeSeries | undefined,
  comparisonLabel: string | undefined
): ReactNode {
  return chart && hasTimeSeriesData(chart) ? (
    <TimeSeriesAreaChart
      comparison={comparison}
      comparisonLabel={comparisonLabel}
      points={chart.points}
      series={chart.series}
    />
  ) : (
    <ChartEmpty message={LOCAL_DATA_UNAVAILABLE} />
  );
}

function renderTimeSeriesBar(chart: TimeSeries | undefined): ReactNode {
  return chart && hasTimeSeriesData(chart) ? (
    <CategoryBarChart data={timeSeriesToBuckets(chart)} />
  ) : (
    <ChartEmpty message={LOCAL_DATA_UNAVAILABLE} />
  );
}

function renderHeatmap(chart: TimeSeries | undefined): ReactNode {
  if (!(chart && hasTimeSeriesData(chart))) {
    return <ChartEmpty message={LOCAL_DATA_UNAVAILABLE} />;
  }
  return <HeatmapChart chart={chart} />;
}

function HeatmapChart({ chart }: { chart: TimeSeries }) {
  // The sort + iterative Date walk is non-trivial; memoize per chart so it
  // doesn't recompute on every tile re-render.
  const weeks = useMemo(() => timeSeriesToHeatmapWeeks(chart), [chart]);
  return <ActivityHeatmap weeks={weeks} />;
}

function renderCategory(
  tile: TileDescriptor,
  data: CategoryBucket[] | undefined
): ReactNode {
  if (!data?.some((bucket) => bucket.value > 0)) {
    return <ChartEmpty message={LOCAL_DATA_UNAVAILABLE} />;
  }
  return tile.kind === TileKind.Donut ? (
    <DonutChart data={data} />
  ) : (
    <CategoryBarChart data={data} horizontal={tile.horizontal} />
  );
}

function getDeliveryTimeSeries(
  key: string,
  response: DeliveryInsightsResponse
): TimeSeries | undefined {
  switch (key) {
    case "prTrend":
      return response.charts.prTrend;
    case "klocTrend":
      return response.charts.klocTrend;
    default:
      return undefined;
  }
}

function getUtilizationTimeSeries(
  key: string,
  response: UtilizationInsightsResponse
): TimeSeries | undefined {
  switch (key) {
    case "eventActivity":
      return response.charts.eventActivity;
    case "eventVolume":
      return response.charts.eventVolume;
    default:
      return undefined;
  }
}

function getAgentsTimeSeries(
  key: string,
  response: AgentsInsightsResponse
): TimeSeries | undefined {
  switch (key) {
    case "modelUsageOverTime":
      return response.charts.modelUsageOverTime;
    case "toolRunsOverTime":
      return response.charts.toolRunsOverTime;
    default:
      return undefined;
  }
}

function getDeliveryCategory(
  key: string,
  charts: DeliveryInsightsResponse["charts"]
): CategoryBucket[] | undefined {
  switch (key) {
    case "prByRepo":
      return charts.prByRepo;
    case "meanTimeToMerge":
      return charts.meanTimeToMerge;
    case "prByState":
      return charts.prByState;
    case "checkStatus":
      return charts.checkStatus;
    case "branchLifespan":
      return charts.branchLifespan;
    case "branchesWithoutPr":
      return charts.branchesWithoutPr;
    default:
      return undefined;
  }
}

function getUtilizationCategory(
  key: string,
  charts: UtilizationInsightsResponse["charts"]
): CategoryBucket[] | undefined {
  switch (key) {
    case "eventsByType":
      return charts.eventsByType;
    case "sessionsByStatus":
      return charts.sessionsByStatus;
    case "userBreakdown":
      return charts.userBreakdown;
    case "reviewQueue":
      return charts.reviewQueue;
    default:
      return undefined;
  }
}

function getAgentsCategory(
  key: string,
  charts: AgentsInsightsResponse["charts"]
): CategoryBucket[] | undefined {
  switch (key) {
    case "modelBreakdown":
      return charts.modelBreakdown;
    case "tokenDistribution":
      return charts.tokenDistribution;
    case "toolUsage":
      return charts.toolUsage;
    case "agentsByStatus":
      return charts.agentsByStatus;
    case "agentsByType":
      return charts.agentsByType;
    default:
      return undefined;
  }
}

function timeSeriesToBuckets(chart: TimeSeries): CategoryBucket[] {
  return chart.points.map((point) => ({
    key: point.date,
    label: formatDateLabel(point.date),
    value: chart.series.reduce(
      (sum, series) => sum + (point.values[series.key] ?? 0),
      0
    ),
  }));
}

function timeSeriesToHeatmapWeeks(
  chart: TimeSeries
): Array<Array<{ date: string; count: number }>> {
  const counts = new Map(
    chart.points.map((point) => [
      point.date,
      chart.series.reduce(
        (sum, series) => sum + (point.values[series.key] ?? 0),
        0
      ),
    ])
  );
  const dates = chart.points
    .map((point) => point.date)
    .sort((a, b) => a.localeCompare(b));
  const firstDate = dates[0];
  const lastDate = dates.at(-1);
  if (!(firstDate && lastDate)) {
    return [];
  }

  const cursor = new Date(`${firstDate}T12:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - cursor.getUTCDay());
  const end = new Date(`${lastDate}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));

  const weeks: Array<Array<{ date: string; count: number }>> = [];
  let week: Array<{ date: string; count: number }> = [];
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    week.push({ date, count: counts.get(date) ?? 0 });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return weeks;
}

function hasTimeSeriesData(chart: TimeSeries): boolean {
  return chart.points.some((point) =>
    chart.series.some((series) => (point.values[series.key] ?? 0) > 0)
  );
}

function formatDateLabel(date: string): string {
  const parts = date.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : date;
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="grid h-full min-h-24 place-items-center text-muted-foreground text-xs">
      {message}
    </div>
  );
}
