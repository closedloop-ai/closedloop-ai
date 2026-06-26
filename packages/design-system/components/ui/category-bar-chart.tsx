"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { chartColor } from "./chart-colors";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
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
}: {
  data: CategoryDatum[];
  horizontal?: boolean;
  emptyMessage?: string;
}) {
  if (data.length === 0 || data.every((datum) => datum.value === 0)) {
    return <ChartEmpty message={emptyMessage} />;
  }
  const colored = data.map((datum, index) => ({
    ...datum,
    fill: chartColor(index),
  }));

  return (
    <ChartContainer className="h-full w-full" config={CHART_CONFIG}>
      <BarChart
        accessibilityLayer
        data={colored}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
      >
        <CartesianGrid
          horizontal={!horizontal}
          strokeDasharray="3 3"
          vertical={horizontal}
        />
        {horizontal ? (
          <>
            <XAxis hide tickFormatter={formatNumberTick} type="number" />
            <YAxis
              axisLine={true}
              dataKey="label"
              tick={{ fontSize: 11 }}
              tickLine={false}
              type="category"
              width={110}
            />
          </>
        ) : (
          <>
            <XAxis
              axisLine={true}
              dataKey="label"
              interval={0}
              tick={{ fontSize: 11 }}
              tickLine={false}
              type="category"
            />
            <YAxis
              allowDecimals={false}
              axisLine={true}
              tick={{ fontSize: 11 }}
              tickFormatter={formatNumberTick}
              tickLine={false}
              type="number"
            />
          </>
        )}
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        {/* Round only the bar's free end; the corners meeting the axis stay
            square. radius order is [top-left, top-right, bottom-right,
            bottom-left]: horizontal bars grow rightward (square left edge),
            vertical bars grow upward (square bottom edge). */}
        <Bar
          dataKey="value"
          radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
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
