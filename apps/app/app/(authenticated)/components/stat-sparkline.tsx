"use client";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import type { FC } from "react";
import { Area, AreaChart, XAxis } from "recharts";

// Cast recharts components to work around React 19 JSX type incompatibility.
// recharts types don't expose a 'props' property required by React 19's JSX transform,
// causing build failures despite runtime correctness.
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedAreaChart = AreaChart as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedArea = Area as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedXAxis = XAxis as unknown as FC<any>;
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
          color: "hsl(var(--primary))",
        },
      }}
    >
      <TypedAreaChart data={chartData}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop
              offset="5%"
              stopColor="hsl(var(--primary))"
              stopOpacity={0.8}
            />
            <stop
              offset="95%"
              stopColor="hsl(var(--primary))"
              stopOpacity={0.1}
            />
          </linearGradient>
        </defs>
        <TypedXAxis dataKey="date" hide />
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
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          type="monotone"
        />
      </TypedAreaChart>
    </ChartContainer>
  );
}
