"use client";

import type { DocumentsByType } from "@repo/api/src/types/user";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import { Bar, BarChart, XAxis, YAxis } from "recharts";

const TYPE_LABELS: Record<string, string> = {
  PRD: "PRDs",
  IMPLEMENTATION_PLAN: "Plans",
  TEMPLATE: "Templates",
};

type DocumentsByTypeChartProps = {
  data: DocumentsByType[];
};

export function DocumentsByTypeChart({ data }: DocumentsByTypeChartProps) {
  const chartData = data.map((d) => ({
    type: TYPE_LABELS[d.type] ?? d.type,
    count: d.count,
  }));

  if (chartData.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border bg-muted/50">
        <p className="text-muted-foreground text-sm">No artifacts yet</p>
      </div>
    );
  }

  return (
    <ChartContainer
      className="aspect-auto h-48 w-full"
      config={{
        count: {
          label: "Count",
          color: "hsl(var(--primary))",
        },
      }}
    >
      <BarChart data={chartData} layout="vertical">
        <XAxis allowDecimals={false} type="number" />
        <YAxis
          dataKey="type"
          tick={{ fontSize: 12 }}
          type="category"
          width={80}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
