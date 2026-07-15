"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { chartColor } from "./chart-colors";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  resolveTickFormatter,
} from "./chart";

export type CategoryDatum = {
  key: string;
  label: string;
  value: number;
};

const CHART_CONFIG: ChartConfig = {
  value: { label: "Count", color: "var(--chart-1)" },
};
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

/**
 * Categorical bar chart composite. Renders one colored bar per datum, either
 * vertically (default) or horizontally for label-heavy data. Built on the
 * shared `chart.tsx` primitives + Recharts; framework-agnostic so it renders in
 * both the Next web app and the desktop renderer.
 */
export function CategoryBarChart({
  data,
  horizontal = false,
  emptyMessage = "No data",
  valueFormatter,
  allowDecimals = false,
  showValueLabels = false,
  selectedKey,
  onDatumClick,
}: {
  data: CategoryDatum[];
  horizontal?: boolean;
  emptyMessage?: string;
  // Formats the bar value on the numeric axis + tooltip (e.g. currency).
  // Defaults to a plain grouped-number formatter.
  valueFormatter?: (value: number) => string;
  // Allow fractional ticks on the numeric axis (e.g. sub-dollar spend). Defaults
  // to false so integer-count metrics (tokens, PRs) keep whole-number ticks.
  allowDecimals?: boolean;
  // Render each bar's value (via `valueFormatter`) directly on the bar so it's
  // readable without hovering the tooltip. Defaults to false to preserve the
  // hover-only behavior of existing category charts. Opt in per chart (e.g.
  // Spend by model). The tooltip is unaffected and still shows on hover.
  showValueLabels?: boolean;
  selectedKey?: string | null;
  onDatumClick?: (datum: CategoryDatum) => void;
}) {
  // Memoize the color-decorated data so its reference stays stable across
  // selection-only re-renders. Recharts keys the bar enter-animation off the
  // `data` prop's reference identity (see recharts' useAnimationId); rebuilding
  // this array on every render made the bars re-animate — and visibly jump —
  // each time a datum was selected (FEA-2499). Recomputing only when `data`
  // actually changes keeps the enter animation on real data/range changes while
  // holding the bars still during selection. Selection only moves the overlaid
  // ReferenceLine tracker, which does not alter bar geometry or the axis domain.
  const colored = useMemo(
    () =>
      data.map((datum, index) => ({
        ...datum,
        fill: chartColor(index),
      })),
    [data]
  );

  if (data.length === 0 || data.every((datum) => datum.value === 0)) {
    return <ChartEmpty message={emptyMessage} />;
  }
  const formatTick = resolveTickFormatter(valueFormatter, formatNumberTick);
  const labelByKey = new Map(data.map((datum) => [datum.key, datum.label]));
  const selectedDatum = selectedKey
    ? data.find((datum) => datum.key === selectedKey)
    : undefined;
  const handleChartClick = onDatumClick
    ? (event: unknown) => {
        const datum = resolveClickedDatum(event, data);
        if (datum) {
          onDatumClick(datum);
        }
      }
    : undefined;

  return (
    <ChartContainer className="h-full w-full" config={CHART_CONFIG}>
      <BarChart
        accessibilityLayer
        data={colored}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{
          top: 8,
          right: 12,
          bottom: 4,
          left: 4,
          ...valueLabelMargin(showValueLabels, horizontal),
        }}
        onClick={handleChartClick}
      >
        <CartesianGrid
          horizontal={!horizontal}
          strokeDasharray="3 3"
          vertical={horizontal}
        />
        {horizontal ? (
          <>
            <XAxis hide tickFormatter={formatTick} type="number" />
            {/* interval={0} forces every category (one per horizontal bar) to
                render its label — Recharts otherwise auto-skips ticks when bars
                are dense, leaving unlabeled bars the reader can't identify. */}
            <YAxis
              axisLine={true}
              dataKey="key"
              interval={0}
              tick={{ fontSize: 11 }}
              tickFormatter={(key) => labelByKey.get(String(key)) ?? String(key)}
              tickLine={false}
              type="category"
              width={110}
            />
          </>
        ) : (
          <>
            <XAxis
              axisLine={true}
              dataKey="key"
              interval={0}
              tick={{ fontSize: 11 }}
              tickFormatter={(key) => labelByKey.get(String(key)) ?? String(key)}
              tickLine={false}
              type="category"
            />
            <YAxis
              allowDecimals={allowDecimals}
              axisLine={true}
              tick={{ fontSize: 11 }}
              tickFormatter={formatTick}
              tickLine={false}
              type="number"
            />
          </>
        )}
        <ChartTooltip
          content={
            <ChartTooltipContent hideLabel valueFormatter={valueFormatter} />
          }
        />
        {selectedDatum ? (
          <ReferenceLine
            stroke="var(--foreground)"
            strokeDasharray="4 3"
            strokeWidth={2}
            x={horizontal ? undefined : selectedDatum.key}
            y={horizontal ? selectedDatum.key : undefined}
          />
        ) : null}
        {/* Round only the bar's free end; the corners meeting the axis stay
            square. radius order is [top-left, top-right, bottom-right,
            bottom-left]: horizontal bars grow rightward (square left edge),
            vertical bars grow upward (square bottom edge). */}
        <Bar dataKey="value" radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}>
          {/* On-bar value labels supplement (don't replace) the tooltip. They
              sit past the bar's free end — right for horizontal, top for
              vertical — which keeps tiny bars' labels legible near the axis and
              gives every category its own row/column so labels don't overlap
              even with many models present. */}
          {showValueLabels ? (
            <LabelList
              className="fill-foreground tabular-nums"
              dataKey="value"
              fontSize={11}
              formatter={(value) => formatTick(Number(value))}
              position={horizontal ? "right" : "top"}
            />
          ) : null}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

function resolveClickedDatum(
  event: unknown,
  data: CategoryDatum[]
): CategoryDatum | undefined {
  if (hasActivePayload(event)) {
    return resolvePayloadDatum(event, data);
  }

  const index = getActiveTooltipIndex(event);
  return typeof index === "number" ? data[index] : undefined;
}

function hasActivePayload(event: unknown): boolean {
  return isRecord(event) && Array.isArray(event.activePayload);
}

function resolvePayloadDatum(
  event: unknown,
  data: CategoryDatum[]
): CategoryDatum | undefined {
  if (!isRecord(event) || !Array.isArray(event.activePayload)) {
    return undefined;
  }

  const matchingKeys = new Set<string>();
  for (const item of event.activePayload) {
    const payload = isRecord(item) ? item.payload : undefined;
    const key = isRecord(payload) ? payload.key : undefined;
    if (typeof key === "string" && data.some((datum) => datum.key === key)) {
      matchingKeys.add(key);
    }
  }

  if (matchingKeys.size !== 1) {
    return undefined;
  }
  const [key] = matchingKeys;
  return data.find((datum) => datum.key === key);
}

function getActiveTooltipIndex(event: unknown): number | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const { activeTooltipIndex } = event;
  if (typeof activeTooltipIndex === "number") {
    return Number.isInteger(activeTooltipIndex) ? activeTooltipIndex : undefined;
  }
  if (
    typeof activeTooltipIndex === "string" &&
    activeTooltipIndex.trim() !== ""
  ) {
    const index = Number(activeTooltipIndex);
    return Number.isInteger(index) ? index : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Extra plot margin reserving room for on-bar value labels so they aren't
// clipped past the bar's free end: horizontal bars grow rightward, vertical
// bars grow upward. Empty when labels are off so default layout is unchanged.
function valueLabelMargin(
  showValueLabels: boolean,
  horizontal: boolean
): { right: number } | { top: number } | Record<string, never> {
  if (!showValueLabels) {
    return {};
  }
  return horizontal ? { right: 52 } : { top: 20 };
}

function formatNumberTick(value: number | string): string {
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue)
    ? NUMBER_FORMATTER.format(numericValue)
    : String(value);
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="grid h-full min-h-24 place-items-center rounded-md border border-dashed bg-muted/20 p-4 text-center text-muted-foreground text-xs">
      {message}
    </div>
  );
}
