"use client";

import { Cell, Pie, PieChart } from "recharts";
import { chartColor } from "./chart-colors";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./chart";

export type DonutDatum = {
  key: string;
  label: string;
  value: number;
};

/**
 * Donut (ring) chart composite for part-of-whole categorical data. Built on the
 * shared `chart.tsx` primitives + Recharts; framework-agnostic.
 */
export function DonutChart({
  data,
  emptyMessage = "No data",
  valueFormatter,
}: {
  data: DonutDatum[];
  emptyMessage?: string;
  // Formats the slice value shown in the tooltip (e.g. currency). Defaults to
  // the shared tooltip number formatting.
  valueFormatter?: (value: number) => string;
}) {
  const total = data.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) {
    return (
      <div className="grid h-full min-h-24 place-items-center rounded-md border border-dashed bg-muted/20 p-4 text-center text-muted-foreground text-xs">
        {emptyMessage}
      </div>
    );
  }

  const config: ChartConfig = {};
  for (let i = 0; i < data.length; i++) {
    config[data[i].key] = { label: data[i].label, color: chartColor(i) };
  }

  return (
    <ChartContainer className="h-full w-full" config={config}>
      <PieChart>
        <ChartTooltip
          content={
            <ChartTooltipContent
              hideLabel
              nameKey="key"
              valueFormatter={valueFormatter}
            />
          }
        />
        <Pie
          data={data}
          dataKey="value"
          innerRadius="55%"
          nameKey="key"
          outerRadius="80%"
        >
          {data.map((slice, index) => (
            <Cell fill={chartColor(index)} key={slice.key} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent nameKey="key" />} />
      </PieChart>
    </ChartContainer>
  );
}
