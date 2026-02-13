"use client";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import type { FC } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

// Cast recharts components to work around React 19 JSX type incompatibility.
// recharts types don't expose a 'props' property required by React 19's JSX transform,
// causing build failures despite runtime correctness.
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedAreaChart = AreaChart as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedArea = Area as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedXAxis = XAxis as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedYAxis = YAxis as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedCartesianGrid = CartesianGrid as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedChartTooltip = ChartTooltip as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedChartTooltipContent = ChartTooltipContent as unknown as FC<any>;

type StatSparklineProps = {
  chartData: Array<{ date: string; count: number }>;
  gradientId: string;
};

function formatDateLabel(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function StatSparkline({ chartData, gradientId }: StatSparklineProps) {
  return (
    <ChartContainer
      className="aspect-auto h-full w-full"
      config={{
        count: {
          label: "Count",
          color: "var(--chart-1)",
        },
      }}
    >
      <TypedAreaChart
        data={chartData}
        margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.4} />
            <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <TypedCartesianGrid
          stroke="hsl(var(--border))"
          strokeDasharray="3 3"
          strokeOpacity={0.5}
          vertical={false}
        />
        <TypedXAxis
          axisLine={false}
          dataKey="date"
          interval="preserveStartEnd"
          minTickGap={30}
          tick={{ fontSize: 10 }}
          tickFormatter={formatDateLabel}
          tickLine={false}
        />
        <TypedYAxis
          allowDecimals={false}
          axisLine={false}
          tick={{ fontSize: 10 }}
          tickLine={false}
          width={35}
        />
        <TypedChartTooltip
          content={
            <TypedChartTooltipContent
              indicator="line"
              labelFormatter={formatDateLabel}
            />
          }
        />
        <TypedArea
          dataKey="count"
          fill={`url(#${gradientId})`}
          stroke="var(--chart-1)"
          strokeWidth={2}
          type="monotone"
        />
      </TypedAreaChart>
    </ChartContainer>
  );
}
