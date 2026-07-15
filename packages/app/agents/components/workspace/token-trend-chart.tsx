"use client";

import type {
  TokenTrendPoint,
  TokenTrendResponse,
} from "@repo/api/src/types/agent-component-analytics";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  TimeSeriesAreaChart,
  type TimeSeriesPointDatum,
  type TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import { useAgentComponentTokenTrend } from "../../hooks/use-agent-component-token-trend";

/**
 * Token-trend chart for a single agent component (FEA-2923 / AC-018).
 *
 * Consumes `useAgentComponentTokenTrend(slug)` (GET
 * /agent-components/{slug}/token-trend) and renders a stacked per-model
 * time-series of total tokens (input + output) bucketed by session start day.
 *
 * This is the missing web consumer for the token-trend endpoint: it turns the
 * raw per-(session × model) points into the `{ series, points }` shape the
 * generic `TimeSeriesAreaChart` primitive expects.
 */
export function TokenTrendChart({ slug }: { slug: string }) {
  const { data, isLoading, isError, error } = useAgentComponentTokenTrend(slug);

  if (isLoading) {
    return <Skeleton className="h-56 w-full" />;
  }

  if (isError) {
    return (
      <p className="text-destructive text-sm">
        Failed to load token trend
        {error instanceof Error ? `: ${error.message}` : ""}.
      </p>
    );
  }

  const { series, points } = toChartData(data);

  return (
    <div className="h-56 w-full">
      <TimeSeriesAreaChart
        emptyMessage="No token usage recorded for this component yet."
        points={points}
        series={series}
      />
    </div>
  );
}

/**
 * Total tokens (input + output) charted per day; input/output are summed since
 * the y-axis is "total tokens". Cache tokens are intentionally excluded to keep
 * the trend focused on billable throughput.
 */
function totalTokens(point: TokenTrendPoint): number {
  return point.inputTokens + point.outputTokens;
}

/** Bucket key: YYYY-MM-DD derived from the ISO session start timestamp. */
function bucketDate(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * Maps a `TokenTrendResponse` into the generic chart's `{ series, points }`
 * props: one series per model, one point per day summing total tokens by model.
 */
export function toChartData(data: TokenTrendResponse | undefined): {
  series: TimeSeriesSeriesDef[];
  points: TimeSeriesPointDatum[];
} {
  if (!data || data.points.length === 0) {
    return { series: [], points: [] };
  }

  const series: TimeSeriesSeriesDef[] = data.models.map((model) => ({
    key: model,
    label: model,
  }));

  const byDate = new Map<string, Record<string, number>>();
  for (const point of data.points) {
    const date = bucketDate(point.sessionStartedAt);
    const values = byDate.get(date) ?? {};
    values[point.model] = (values[point.model] ?? 0) + totalTokens(point);
    byDate.set(date, values);
  }

  const points: TimeSeriesPointDatum[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, values }));

  return { series, points };
}
