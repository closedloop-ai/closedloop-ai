"use client";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import { Bar, BarChart, XAxis, YAxis } from "recharts";

type ApprovalDistributionChartProps = {
  distribution: Record<"lt1d" | "1to3d" | "3to7d" | "gt7d", number>;
};

const chartConfig: ChartConfig = {
  count: {
    label: "PRs",
    color: "var(--chart-1)",
  },
};

export function ApprovalDistributionChart({
  distribution,
}: ApprovalDistributionChartProps) {
  const chartData = [
    { label: "< 1 day", count: distribution.lt1d },
    { label: "1-3 days", count: distribution["1to3d"] },
    { label: "3-7 days", count: distribution["3to7d"] },
    { label: "> 7 days", count: distribution.gt7d },
  ];

  return (
    <ChartContainer className="h-48 w-full" config={chartConfig}>
      <BarChart data={chartData}>
        <XAxis dataKey="label" />
        <YAxis allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
