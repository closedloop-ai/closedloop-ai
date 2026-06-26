"use client";

import type { DocumentsByType } from "@repo/api/src/types/user";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import type { FC } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";

// Cast recharts components to work around React 19 JSX type incompatibility.
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedBarChart = BarChart as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedBar = Bar as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedXAxis = XAxis as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedYAxis = YAxis as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedChartTooltip = ChartTooltip as unknown as FC<any>;
// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const TypedChartTooltipContent = ChartTooltipContent as unknown as FC<any>;

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
      <TypedBarChart data={chartData} layout="vertical">
        <TypedXAxis allowDecimals={false} type="number" />
        <TypedYAxis
          dataKey="type"
          tick={{ fontSize: 12 }}
          type="category"
          width={80}
        />
        <TypedChartTooltip content={<TypedChartTooltipContent />} />
        <TypedBar
          dataKey="count"
          fill="hsl(var(--primary))"
          radius={[0, 4, 4, 0]}
        />
      </TypedBarChart>
    </ChartContainer>
  );
}
