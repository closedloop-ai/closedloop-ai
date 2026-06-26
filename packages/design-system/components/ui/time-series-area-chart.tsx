"use client";

import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { chartColor } from "./chart-colors";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./chart";

export type TimeSeriesSeriesDef = {
  key: string;
  label: string;
};

export type TimeSeriesPointDatum = {
  // Bucket date as YYYY-MM-DD.
  date: string;
  // seriesKey -> value; missing series are treated as 0.
  values: Record<string, number>;
};

const DATE_PART_COUNT = 3;
// Compact notation keeps y-axis ticks short (e.g. "6M", "1.5M") so large token
// counts don't get clipped at the chart's left edge. Tooltips still show the
// full value.
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Time-series area chart composite. Renders one area per series; multiple
 * series stack. Built on the shared `chart.tsx` primitives + Recharts;
 * framework-agnostic.
 */
export function TimeSeriesAreaChart({
  series,
  points,
  comparison,
  comparisonLabel,
  emptyMessage = "No data",
}: {
  series: TimeSeriesSeriesDef[];
  points: TimeSeriesPointDatum[];
  comparison?: {
    series: TimeSeriesSeriesDef[];
    points: TimeSeriesPointDatum[];
  };
  comparisonLabel?: string;
  emptyMessage?: string;
}) {
  if (isEmptyTimeSeries(points, series)) {
    return <ChartEmpty message={emptyMessage} />;
  }

  const config: ChartConfig = {};
  // Resolve each series' palette color up front and bind it to the Area
  // directly (below). We can't route through the `--color-<key>` CSS variable
  // that `chart.tsx` emits: model keys like "gpt-5.4" contain a ".", which is
  // not a valid CSS identifier character, so `var(--color-gpt-5.4)` resolves to
  // nothing and the series renders uncolored.
  const colorByKey: Record<string, string> = {};
  for (let i = 0; i < series.length; i++) {
    const color = chartColor(i);
    config[series[i].key] = { label: series[i].label, color };
    colorByKey[series[i].key] = color;
  }
  const comparisonKey = "comparisonTrend";
  const comparisonPoints =
    comparison && !isEmptyTimeSeries(comparison.points, comparison.series)
      ? buildComparisonValues(comparison)
      : new Map<string, number>();
  if (comparisonPoints.size > 0) {
    config[comparisonKey] = {
      label: comparisonLabel ?? "Comparison",
      color: "var(--foreground)",
    };
  }

  const rows = points.map((point) => ({
    date: point.date,
    ...point.values,
    ...(comparisonPoints.has(point.date)
      ? { [comparisonKey]: comparisonPoints.get(point.date) }
      : {}),
  }));
  const multiSeries = series.length > 1;

  return (
    <ChartContainer className="h-full w-full" config={config}>
      <AreaChart
        accessibilityLayer
        data={rows}
        margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          axisLine={true}
          dataKey="date"
          minTickGap={32}
          tick={{ fontSize: 11 }}
          tickFormatter={formatDateTick}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          axisLine={true}
          tick={{ fontSize: 11 }}
          tickFormatter={formatNumberTick}
          tickLine={false}
          width={56}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        {series.map((entry) => (
          <Area
            dataKey={entry.key}
            fill={colorByKey[entry.key]}
            fillOpacity={0.2}
            key={entry.key}
            stackId={multiSeries ? "stack" : undefined}
            stroke={colorByKey[entry.key]}
            type="monotone"
          />
        ))}
        {comparisonPoints.size > 0 ? (
          <Line
            dataKey={comparisonKey}
            dot={false}
            stroke={`var(--color-${comparisonKey})`}
            strokeDasharray="4 4"
            strokeWidth={2}
            type="monotone"
          />
        ) : null}
        {multiSeries || comparisonPoints.size > 0 ? (
          <ChartLegend content={<ChartLegendContent />} />
        ) : null}
      </AreaChart>
    </ChartContainer>
  );
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="grid h-full min-h-24 place-items-center rounded-md border border-dashed bg-muted/20 p-4 text-center text-muted-foreground text-xs">
      {message}
    </div>
  );
}

function isEmptyTimeSeries(
  points: TimeSeriesPointDatum[],
  series: TimeSeriesSeriesDef[]
): boolean {
  return (
    points.length === 0 ||
    series.length === 0 ||
    points.every((point) =>
      series.every((entry) => (point.values[entry.key] ?? 0) === 0)
    )
  );
}

function buildComparisonValues({
  points,
  series,
}: {
  points: TimeSeriesPointDatum[];
  series: TimeSeriesSeriesDef[];
}): Map<string, number> {
  const values = new Map<string, number>();
  for (const point of points) {
    values.set(
      point.date,
      series.reduce((sum, entry) => sum + (point.values[entry.key] ?? 0), 0)
    );
  }
  return values;
}

function formatDateTick(value: string): string {
  const parts = value.split("-");
  return parts.length === DATE_PART_COUNT ? `${parts[1]}/${parts[2]}` : value;
}

function formatNumberTick(value: number | string): string {
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue)
    ? NUMBER_FORMATTER.format(numericValue)
    : String(value);
}
