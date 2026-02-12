"use client";

import { ChartContainer } from "@repo/design-system/components/ui/chart";
import { Area, AreaChart } from "recharts";

type StatSparklineProps = {
  chartData: Array<{ date: string; count: number }>;
  gradientId: string;
};

export function StatSparkline({ chartData, gradientId }: StatSparklineProps) {
  return (
    <ChartContainer
      config={{
        count: {
          label: "Count",
          color: "hsl(var(--primary))",
        },
      }}
    >
      <AreaChart data={chartData}>
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
        <Area
          dataKey="count"
          fill={`url(#${gradientId})`}
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          type="monotone"
        />
      </AreaChart>
    </ChartContainer>
  );
}
