"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Label,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  chartColor,
  CHART_OTHER_SERIES_COLOR,
  CHART_SERIES_COLOR_LIMIT,
  chartSeriesColor,
} from "./chart-colors";
import {
  type FoldablePointDatum,
  type FoldableSeriesDef,
  foldTimeSeriesToMaxSeries,
} from "./chart-series-fold";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  resolveTickFormatter,
  useChartLegendState,
} from "./chart";

/**
 * One drawn series. ISS-5523: aliased onto the fold module's canonical shape
 * rather than re-declared, so `foldTimeSeriesToMaxSeries`'s output is assignable
 * to this chart's props because the compiler says so, not because two identical
 * declarations happen to agree. A field added to one is a field on both.
 */
export type TimeSeriesSeriesDef = FoldableSeriesDef;

/**
 * One time bucket: `date` is YYYY-MM-DD, `values` maps seriesKey -> value where
 * a missing series is treated as 0 and an explicit `null` renders as a gap.
 * Aliased onto the fold module's canonical shape — see above.
 */
export type TimeSeriesPointDatum = FoldablePointDatum;

/**
 * A vertical event marker drawn on the time axis at `date` (a YYYY-MM-DD bucket
 * that must match one of the chart's `points[].date`, so the line lands on a
 * real x tick). Used to annotate the series with out-of-band events — e.g. an
 * agent-component version being created or first used — so a change in usage can
 * be read against the event that caused it.
 */
export type TimeSeriesMarker = {
  // The x bucket the marker sits on (YYYY-MM-DD). Off-axis dates are skipped so
  // Recharts never drops the line to x=0.
  date: string;
  // Short on-chart tag (e.g. "v3"). Kept terse so stacked markers stay legible.
  label: string;
  // Accessible, human-readable description of the event (e.g. "Version 3
  // created 2026-06-02"). Rendered as the line's SVG title for screen readers.
  description: string;
};

const DATE_PART_COUNT = 3;
// Series key for the optional dashed comparison trend line. Module-scoped so the
// config, the drawn <Line>, and the hidden-series toggle all agree on one id.
const COMPARISON_KEY = "comparisonTrend";
// Separators for merging same-day marker labels/descriptions onto one line so
// two events on one day never overpaint each other (see resolveDrawableMarkers).
const MARKER_LABEL_SEPARATOR = " · ";
const MARKER_DESCRIPTION_SEPARATOR = "; ";
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
  markers,
  emptyMessage = "No data",
  valueFormatter,
  allowDecimals = false,
  colorOffset = 0,
  maxSeries,
  otherSeriesLabel,
  resetKey,
}: {
  series: TimeSeriesSeriesDef[];
  points: TimeSeriesPointDatum[];
  comparison?: {
    series: TimeSeriesSeriesDef[];
    points: TimeSeriesPointDatum[];
  };
  comparisonLabel?: string;
  // Vertical event markers drawn on the time axis (e.g. version-lifecycle
  // events). Only markers whose `date` matches a rendered bucket are drawn.
  markers?: readonly TimeSeriesMarker[];
  emptyMessage?: string;
  // Formats the y-axis ticks + tooltip values (e.g. currency). Defaults to the
  // compact number formatter.
  valueFormatter?: (value: number) => string;
  // Allow fractional y-axis ticks (e.g. sub-dollar spend). Defaults to false so
  // integer-count metrics keep whole-number ticks.
  allowDecimals?: boolean;
  // Shifts the categorical palette start so two single-series charts stacked on
  // the same page don't both resolve to `--chart-1`. Each series still takes a
  // distinct color within the chart; the offset only moves where the sequence
  // begins (e.g. `colorOffset={1}` starts at `--chart-2`).
  colorOffset?: number;
  // ISS-5523: the most series this chart may draw with its own color. Past this
  // many, the lowest-magnitude series fold into one aggregate "Other" band drawn
  // in a neutral, so no two bands can ever share a fill. Leave it unset and the
  // chart draws every series exactly as before, cycling the palette — the
  // pre-ISS-5523 behavior, which callers keep until their gate opens.
  // `CHART_SERIES_COLOR_LIMIT` is the largest value the palette can honor.
  maxSeries?: number;
  // The noun the aggregate band is named with, e.g. "Other models" renders as
  // "Other models (7)". A generic chart cannot know what its series ARE, so the
  // owning surface supplies the word; the count is always appended so the band
  // states how much of the population it stands for.
  otherSeriesLabel?: string;
  // FEA-4264 (wongk review): a semantic identity for the data this chart draws.
  // The interactive legend's hidden-series state lives in ChartContainer; when a
  // consumer reuses one instance across a data-identity change, pass a new
  // `resetKey` so hidden series clear and a series hidden under one identity
  // doesn't carry into the next. Consumers that remount per identity (React
  // `key`) don't need this.
  resetKey?: string;
}) {
  if (isEmptyTimeSeries(points, series)) {
    return <ChartEmpty message={emptyMessage} />;
  }

  // ISS-5523: fold before anything reads `series`, so the config, the palette
  // assignment, the stack, the legend and the tooltip all see one population.
  // Emptiness is judged on the ORIGINAL series above — folding never changes
  // whether there is data, only how many bands carry it.
  //
  // The cap is clamped to what the palette can actually seat. A caller asking
  // for more would get every series past the last slot painted the aggregate
  // band's neutral — several bands sharing one fill, the exact defect this
  // prop exists to remove.
  const seriesCap =
    maxSeries === undefined
      ? undefined
      : Math.min(maxSeries, CHART_SERIES_COLOR_LIMIT);
  const folded = foldTimeSeriesToMaxSeries({
    maxSeries: seriesCap,
    otherSeriesLabel,
    points,
    series,
  });
  const drawnSeries = folded.series;
  const drawnPoints = folded.points;
  // Keyed on the cap being REQUESTED, not on a fold having happened. Keying it
  // on the fold made the palette order flip the moment a chart crossed the
  // threshold — one new series in range repainted every band — and left a
  // below-cap chart on the natural order this ticket measured as failing.
  const capped = seriesCap !== undefined;

  const config: ChartConfig = {};
  // Resolve each series' palette color up front and bind it to the Area
  // directly (below). We can't route through the `--color-<key>` CSS variable
  // that `chart.tsx` emits: model keys like "gpt-5.4" contain a ".", which is
  // not a valid CSS identifier character, so `var(--color-gpt-5.4)` resolves to
  // nothing and the series renders uncolored.
  const colorByKey: Record<string, string> = {};
  // The aggregate band leads `drawnSeries` but must not consume a palette slot,
  // so real series are numbered independently of their position in the array.
  let paletteSlot = 0;
  for (const entry of drawnSeries) {
    const isAggregate = entry.key === folded.aggregateKey;
    const color = resolveSeriesColor(
      entry.key,
      capped ? paletteSlot : paletteSlot + colorOffset,
      capped,
      folded
    );
    if (!isAggregate) {
      paletteSlot += 1;
    }
    config[entry.key] = { label: entry.label, color };
    colorByKey[entry.key] = color;
  }
  const comparisonPoints =
    comparison && !isEmptyTimeSeries(comparison.points, comparison.series)
      ? buildComparisonValues(comparison)
      : new Map<string, number>();
  if (comparisonPoints.size > 0) {
    config[COMPARISON_KEY] = {
      label: comparisonLabel ?? "Comparison",
      color: "var(--foreground)",
    };
  }

  const rows = drawnPoints.map((point) => ({
    date: point.date,
    ...point.values,
    ...(comparisonPoints.has(point.date)
      ? { [COMPARISON_KEY]: comparisonPoints.get(point.date) }
      : {}),
  }));

  return (
    <ChartContainer className="h-full w-full" config={config} resetKey={resetKey}>
      {/* FEA-4264: the plot lives in a child of ChartContainer so it can read
          the interactive-legend hidden-series state from context and drop
          toggled-off areas. */}
      <TimeSeriesAreaChartPlot
        allowDecimals={allowDecimals}
        colorByKey={colorByKey}
        comparisonPoints={comparisonPoints}
        markers={markers}
        points={drawnPoints}
        rows={rows}
        series={drawnSeries}
        valueFormatter={valueFormatter}
      />
    </ChartContainer>
  );
}

// The inner plot renders under ChartContainer's provider so it can consult the
// interactive-legend hidden-series set (FEA-4264) and omit any Area the user
// toggled off. Kept a direct child of ResponsiveContainer's dimension context —
// Recharts 3 sizes via context, so this wrapper does not break layout.
function TimeSeriesAreaChartPlot({
  series,
  rows,
  points,
  colorByKey,
  comparisonPoints,
  markers,
  valueFormatter,
  allowDecimals,
}: {
  series: TimeSeriesSeriesDef[];
  rows: Record<string, number | null | string | undefined>[];
  points: TimeSeriesPointDatum[];
  colorByKey: Record<string, string>;
  comparisonPoints: Map<string, number>;
  markers: readonly TimeSeriesMarker[] | undefined;
  valueFormatter: ((value: number) => string) | undefined;
  allowDecimals: boolean;
}) {
  const { isSeriesHidden } = useChartLegendState();
  const formatTick = resolveTickFormatter(valueFormatter, formatNumberTick);
  const multiSeries = series.length > 1;
  // Only draw markers that land on a rendered bucket — an off-axis `x` makes
  // Recharts drop the line to x=0, which would lie about when the event happened.
  const drawnMarkers = resolveDrawableMarkers(markers, points);

  return (
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
        allowDecimals={allowDecimals}
        axisLine={true}
        tick={{ fontSize: 11 }}
        tickFormatter={formatTick}
        tickLine={false}
        width={56}
      />
      <ChartTooltip
        content={<ChartTooltipContent valueFormatter={valueFormatter} />}
      />
      {series.map((entry) => (
        <Area
          dataKey={entry.key}
          fill={colorByKey[entry.key]}
          fillOpacity={0.2}
          // FEA-4264: a legend click hides this series. `hide` drops it from the
          // stack cleanly (the remaining series restack) instead of leaving a
          // zero-height band, and the tooltip stops listing it.
          hide={isSeriesHidden(entry.key)}
          key={entry.key}
          stackId={multiSeries ? "stack" : undefined}
          stroke={colorByKey[entry.key]}
          type="monotone"
        />
      ))}
      {comparisonPoints.size > 0 ? (
        <Line
          dataKey={COMPARISON_KEY}
          dot={false}
          hide={isSeriesHidden(COMPARISON_KEY)}
          stroke={`var(--color-${COMPARISON_KEY})`}
          strokeDasharray="4 4"
          strokeWidth={2}
          type="monotone"
        />
      ) : null}
      {drawnMarkers.map((marker) => (
        <ReferenceLine
          key={`${marker.date}:${marker.label}`}
          stroke="var(--muted-foreground)"
          strokeDasharray="3 3"
          x={marker.date}
        >
          {/* The SVG <title> gives the otherwise decorative line an accessible
              name; the visible tag stays terse so stacked markers don't
              collide. */}
          <title>{marker.description}</title>
          <Label
            className="fill-muted-foreground"
            fontSize={11}
            position="insideTopRight"
            value={marker.label}
          />
        </ReferenceLine>
      ))}
      {multiSeries || comparisonPoints.size > 0 ? (
        <ChartLegend content={<ChartLegendContent />} />
      ) : null}
    </AreaChart>
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

/**
 * Keep only markers that land on a bucket the chart actually renders, then merge
 * every marker sharing a date into a single line so same-day events never
 * overpaint each other.
 *
 * A `ReferenceLine` whose `x` is not among the categorical x values is dropped
 * by Recharts to x=0, which would mis-place the event; skipping off-axis markers
 * keeps every drawn line honest. Two markers on the SAME day (e.g. a version's
 * "created" and "first used" events, which commonly fall on one day) would draw
 * two `ReferenceLine`s at the identical x with identically-positioned
 * `insideTopRight` labels, so the tags paint over each other and one line hides
 * behind the other. Instead we draw one line per date: its visible tag joins the
 * distinct labels ("Rev 3 · Rev 3 used") and its accessible description joins
 * the per-event descriptions, so a same-day pair reads as one deliberate mark
 * with a legible combined tag (wongk review, #3756). First-writer wins on label
 * ordering, and duplicate (date, label) pairs collapse.
 */
function resolveDrawableMarkers(
  markers: readonly TimeSeriesMarker[] | undefined,
  points: TimeSeriesPointDatum[]
): TimeSeriesMarker[] {
  if (!markers || markers.length === 0) {
    return [];
  }
  const bucketDates = new Set(points.map((point) => point.date));
  const byDate = new Map<string, { labels: string[]; descriptions: string[] }>();
  const order: string[] = [];
  for (const marker of markers) {
    if (!bucketDates.has(marker.date)) {
      continue;
    }
    let group = byDate.get(marker.date);
    if (!group) {
      group = { labels: [], descriptions: [] };
      byDate.set(marker.date, group);
      order.push(marker.date);
    }
    if (!group.labels.includes(marker.label)) {
      group.labels.push(marker.label);
    }
    if (!group.descriptions.includes(marker.description)) {
      group.descriptions.push(marker.description);
    }
  }
  return order.map((date) => {
    const group = byDate.get(date) as { labels: string[]; descriptions: string[] };
    return {
      date,
      label: group.labels.join(MARKER_LABEL_SEPARATOR),
      description: group.descriptions.join(MARKER_DESCRIPTION_SEPARATOR),
    };
  });
}

/**
 * ISS-5523 — palette slot for one drawn series.
 *
 * Two regimes, deliberately. UNCAPPED (`capped: false`, no `maxSeries`) keeps
 * the historical `chartColor` cycle so every existing caller renders exactly as
 * it did; the cycle is the defect this ticket is about, and callers leave it
 * only when their gate opens. CAPPED uses the adjacent-distinguishable order and
 * cannot wrap, so a fill is never reused, and paints the aggregate band in the
 * neutral so it does not read as one more entity.
 */
function resolveSeriesColor(
  key: string,
  paletteIndex: number,
  capped: boolean,
  folded: { aggregateKey: string | undefined }
): string {
  if (key === folded.aggregateKey) {
    return CHART_OTHER_SERIES_COLOR;
  }
  // `colorOffset` shifts where the UNCAPPED sequence starts so two single-series
  // charts on one page don't both resolve to `--chart-1`. It is deliberately not
  // applied on the capped path: the capped sequence cannot wrap, so an offset
  // would push the last real series off the end and paint it the aggregate
  // band's neutral — two bands, one fill.
  return capped ? chartSeriesColor(paletteIndex) : chartColor(paletteIndex);
}
