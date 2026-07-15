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
import {
  CategoryBarChart,
  type CategoryDatum,
} from "@repo/design-system/components/ui/category-bar-chart";
import { DonutChart } from "@repo/design-system/components/ui/donut-chart";
import { ActivityHeatmap } from "@repo/design-system/components/ui/primitives/activity-heatmap";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useFeatureFlagEnabled } from "../../shared/feature-flags/use-feature-flag-enabled";
import { metricAllowsFractions, metricValueFormatter } from "../lib/format";
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
      comparisonLabel,
      metricValueFormatter(tile.metricKey),
      metricAllowsFractions(tile.metricKey)
    );
  }
  if (tile.kind === TileKind.TimeSeriesBar) {
    return renderTimeSeriesBar(
      getDeliveryTimeSeries(tile.dataKey, response),
      tile.id,
      metricValueFormatter(tile.metricKey),
      metricAllowsFractions(tile.metricKey)
    );
  }
  if (tile.kind === TileKind.Heatmap) {
    return renderHeatmap(
      getDeliveryTimeSeries(tile.dataKey, response),
      metricValueFormatter(tile.metricKey)
    );
  }

  const categoryData = getDeliveryCategory(tile.dataKey, response.charts);
  // FEA-2993: the "Merged PRs by repository" bar tile gains an `emergent`-gated
  // segment drilldown — clicking a repo bar selects it and surfaces a per-repo
  // summary. Other Delivery category tiles (and the repo donut variant) keep the
  // shared, non-interactive renderer.
  if (tile.dataKey === "prByRepo" && tile.kind === TileKind.CategoryBar) {
    return <DeliveryRepoSegmentChart data={categoryData} tile={tile} />;
  }
  return renderCategory(tile, categoryData);
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
      comparisonLabel,
      metricValueFormatter(tile.metricKey),
      metricAllowsFractions(tile.metricKey)
    );
  }
  if (tile.kind === TileKind.TimeSeriesBar) {
    return renderTimeSeriesBar(
      getUtilizationTimeSeries(tile.dataKey, response),
      tile.id,
      metricValueFormatter(tile.metricKey),
      metricAllowsFractions(tile.metricKey)
    );
  }
  if (tile.kind === TileKind.Heatmap) {
    return renderHeatmap(
      getUtilizationTimeSeries(tile.dataKey, response),
      metricValueFormatter(tile.metricKey)
    );
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
      comparisonLabel,
      metricValueFormatter(tile.metricKey),
      metricAllowsFractions(tile.metricKey)
    );
  }
  if (tile.kind === TileKind.TimeSeriesBar) {
    return renderTimeSeriesBar(
      getAgentsTimeSeries(tile.dataKey, response),
      tile.id,
      metricValueFormatter(tile.metricKey),
      metricAllowsFractions(tile.metricKey)
    );
  }
  if (tile.kind === TileKind.Heatmap) {
    return renderHeatmap(
      getAgentsTimeSeries(tile.dataKey, response),
      metricValueFormatter(tile.metricKey)
    );
  }

  return renderCategory(tile, getAgentsCategory(tile.dataKey, response.charts));
}

function renderTimeSeries(
  chart: TimeSeries | undefined,
  comparison: TimeSeries | undefined,
  comparisonLabel: string | undefined,
  valueFormatter: (value: number) => string,
  allowDecimals: boolean
): ReactNode {
  return chart && hasTimeSeriesData(chart) ? (
    <TimeSeriesAreaChart
      allowDecimals={allowDecimals}
      comparison={comparison}
      comparisonLabel={comparisonLabel}
      points={chart.points}
      series={chart.series}
      valueFormatter={valueFormatter}
    />
  ) : (
    <ChartEmpty message={LOCAL_DATA_UNAVAILABLE} />
  );
}

function renderTimeSeriesBar(
  chart: TimeSeries | undefined,
  trackerScopeBaseKey: string,
  valueFormatter: (value: number) => string,
  allowDecimals: boolean
): ReactNode {
  return chart && hasTimeSeriesData(chart) ? (
    <TrackedTimeSeriesBarChart
      allowDecimals={allowDecimals}
      chart={chart}
      trackerScopeBaseKey={trackerScopeBaseKey}
      valueFormatter={valueFormatter}
    />
  ) : (
    <ChartEmpty message={LOCAL_DATA_UNAVAILABLE} />
  );
}

type SelectedBucket = {
  bucketKey: string;
  scopeKey: string;
};

function TrackedTimeSeriesBarChart({
  chart,
  trackerScopeBaseKey,
  valueFormatter,
  allowDecimals,
}: {
  chart: TimeSeries;
  trackerScopeBaseKey: string;
  valueFormatter: (value: number) => string;
  allowDecimals: boolean;
}) {
  const [selectedBucket, setSelectedBucket] = useState<SelectedBucket | null>(
    null
  );
  const buckets = useMemo(() => timeSeriesToBuckets(chart), [chart]);
  const trackerScopeKey = useMemo(
    () => buildTimeSeriesTrackerScopeKey(trackerScopeBaseKey, chart),
    [chart, trackerScopeBaseKey]
  );
  const bucketKeys = useMemo(
    () => new Set(buckets.map((bucket) => bucket.key)),
    [buckets]
  );
  const selectedKey =
    selectedBucket?.scopeKey === trackerScopeKey &&
    bucketKeys.has(selectedBucket.bucketKey)
      ? selectedBucket.bucketKey
      : null;

  useEffect(() => {
    if (
      selectedBucket &&
      (selectedBucket.scopeKey !== trackerScopeKey ||
        !bucketKeys.has(selectedBucket.bucketKey))
    ) {
      setSelectedBucket(null);
    }
  }, [bucketKeys, selectedBucket, trackerScopeKey]);

  return (
    <CategoryBarChart
      allowDecimals={allowDecimals}
      data={buckets}
      onDatumClick={(datum: CategoryDatum) =>
        setSelectedBucket({
          bucketKey: datum.key,
          scopeKey: trackerScopeKey,
        })
      }
      selectedKey={selectedKey}
      valueFormatter={valueFormatter}
    />
  );
}

function renderHeatmap(
  chart: TimeSeries | undefined,
  valueFormatter: (value: number) => string
): ReactNode {
  if (!(chart && hasTimeSeriesData(chart))) {
    return <ChartEmpty message={LOCAL_DATA_UNAVAILABLE} />;
  }
  return <HeatmapChart chart={chart} valueFormatter={valueFormatter} />;
}

function HeatmapChart({
  chart,
  valueFormatter,
}: {
  chart: TimeSeries;
  valueFormatter: (value: number) => string;
}) {
  // The sort + iterative Date walk is non-trivial; memoize per chart so it
  // doesn't recompute on every tile re-render.
  const weeks = useMemo(() => timeSeriesToHeatmapWeeks(chart), [chart]);
  return <ActivityHeatmap valueFormatter={valueFormatter} weeks={weeks} />;
}

function renderCategory(
  tile: TileDescriptor,
  data: CategoryBucket[] | undefined
): ReactNode {
  if (!data?.some((bucket) => bucket.value > 0)) {
    return <ChartEmpty message={LOCAL_DATA_UNAVAILABLE} />;
  }
  const valueFormatter = metricValueFormatter(tile.metricKey);
  return tile.kind === TileKind.Donut ? (
    <DonutChart data={data} valueFormatter={valueFormatter} />
  ) : (
    <CategoryBarChart
      allowDecimals={metricAllowsFractions(tile.metricKey)}
      data={data}
      horizontal={tile.horizontal}
      showValueLabels={tile.showValueLabels}
      valueFormatter={valueFormatter}
    />
  );
}

/**
 * PostHog flag gating the Delivery "segment drilldown" first slice (FEA-2993):
 * clicking a repository bar in the "Merged PRs by repository" tile selects that
 * repo and surfaces a per-segment summary. Reuses the shared `emergent`
 * prototype flag (the same key behind the Insights AI-Impact card and Share
 * link), so the drilldown ships dark until that flag is enabled. Named locally
 * per the per-surface flag-key convention.
 */
export const DELIVERY_SEGMENT_FEATURE_FLAG_KEY = "emergent";

const PERCENT_SCALE = 100;

/**
 * "Merged PRs by repository" tile with an `emergent`-gated segment drilldown.
 * While the flag is off (or there is nothing to drill into) it renders exactly
 * like every other category tile via {@link renderCategory}, including the empty
 * state; while on, repo bars become selectable and a compact summary reports the
 * picked repository's share of delivery throughput. Derived entirely from the
 * `prByRepo` buckets the dashboard already loads — no new API contract or query,
 * mirroring the AI-Impact card's first-slice shape, so it works identically on
 * web and desktop through the shared data port.
 */
function DeliveryRepoSegmentChart({
  tile,
  data,
}: {
  tile: TileDescriptor;
  data: CategoryBucket[] | undefined;
}) {
  const segmentEnabled = useFeatureFlagEnabled(
    DELIVERY_SEGMENT_FEATURE_FLAG_KEY
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const bucketKeys = useMemo(
    () => new Set((data ?? []).map((bucket) => bucket.key)),
    [data]
  );

  // Drop a stale selection when the underlying repo set changes (e.g. a
  // scope/period switch replaces the buckets) so the summary never reports a
  // repo the current chart no longer shows.
  useEffect(() => {
    if (selectedKey !== null && !bucketKeys.has(selectedKey)) {
      setSelectedKey(null);
    }
  }, [bucketKeys, selectedKey]);

  const hasData = data?.some((bucket) => bucket.value > 0) ?? false;
  if (!(segmentEnabled && hasData)) {
    return renderCategory(tile, data);
  }

  const buckets = data ?? [];
  const selected =
    selectedKey === null
      ? undefined
      : buckets.find((bucket) => bucket.key === selectedKey);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="min-h-0 flex-1">
        <CategoryBarChart
          allowDecimals={metricAllowsFractions(tile.metricKey)}
          data={buckets}
          horizontal={tile.horizontal}
          onDatumClick={(datum: CategoryDatum) =>
            setSelectedKey((current) =>
              current === datum.key ? null : datum.key
            )
          }
          selectedKey={selected ? selected.key : null}
          showValueLabels={tile.showValueLabels}
          valueFormatter={metricValueFormatter(tile.metricKey)}
        />
      </div>
      <RepoSegmentSummary
        buckets={buckets}
        metricKey={tile.metricKey}
        selected={selected}
      />
    </div>
  );
}

/**
 * Compact per-repository readout under the drilldown chart. Reports the selected
 * repo's throughput, its share of the delivery total, and its rank — all derived
 * from the already-loaded buckets. Prompts for a selection when none is active
 * so the drilldown affordance stays discoverable.
 */
function RepoSegmentSummary({
  buckets,
  selected,
  metricKey,
}: {
  buckets: CategoryBucket[];
  selected: CategoryBucket | undefined;
  metricKey: string;
}) {
  if (!selected) {
    return (
      <div className="text-muted-foreground text-xs">
        Select a repository to drill into its delivery segment.
      </div>
    );
  }
  const formatValue = metricValueFormatter(metricKey);
  const total = buckets.reduce((sum, bucket) => sum + bucket.value, 0);
  const share =
    total > 0 ? Math.round((selected.value / total) * PERCENT_SCALE) : 0;
  const rank =
    buckets.filter((bucket) => bucket.value > selected.value).length + 1;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="font-medium text-foreground">{selected.label}</span>
      <span className="text-muted-foreground">
        {`${formatValue(selected.value)} · ${share}% of total · #${rank} of ${buckets.length}`}
      </span>
    </div>
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

/**
 * Tracker selection is tied to the rendered chart identity so filter/range
 * changes that reuse date keys cannot leave a marker on a stale scale.
 */
function buildTimeSeriesTrackerScopeKey(
  baseKey: string,
  chart: TimeSeries
): string {
  return JSON.stringify({
    baseKey,
    points: chart.points.map((point) => ({
      date: point.date,
      values: chart.series.map((series) => point.values[series.key] ?? 0),
    })),
    series: chart.series.map((series) => series.key),
  });
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
