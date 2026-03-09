"use client";

import { analytics } from "@repo/analytics";
import type { EvaluationReportType } from "@repo/api/src/types/evaluation";
import {
  PR_TIMELINE_GRANULARITY_OPTIONS,
  PR_TIMELINE_RANGE_OPTIONS,
  type PrTimelineGranularity,
  type PrTimelineRangeOption,
} from "@repo/api/src/types/judges-analytics";
import { useAuth } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { format, parse } from "date-fns";
import { useState } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { usePrHealth } from "@/hooks/queries/use-judges-analytics";

type PrTimelineChartProps = {
  promptName: string;
  reportType: EvaluationReportType;
};

const chartConfig: ChartConfig = {
  count: {
    label: "PRs",
    color: "var(--chart-1)",
  },
};

export function PrTimelineChart({
  promptName,
  reportType,
}: PrTimelineChartProps) {
  const { orgId, userId } = useAuth();
  const [rangeDays, setRangeDays] = useState<PrTimelineRangeOption>(
    PR_TIMELINE_RANGE_OPTIONS.Days90
  );
  const [granularity, setGranularity] = useState<PrTimelineGranularity>(
    PR_TIMELINE_GRANULARITY_OPTIONS.Week
  );

  const { data, isLoading, isError } = usePrHealth(
    promptName,
    reportType,
    rangeDays,
    granularity
  );

  function handleRangeChange(days: PrTimelineRangeOption) {
    setRangeDays(days);
    analytics.capture("PR Timeline Date Range Changed", {
      organization_id: orgId,
      user_id: userId,
      judge_prompt_name: promptName,
      range_days: days,
    });
  }

  function handleGranularityChange(g: PrTimelineGranularity) {
    setGranularity(g);
    analytics.capture("PR Timeline Granularity Changed", {
      organization_id: orgId,
      user_id: userId,
      judge_prompt_name: promptName,
      granularity: g,
    });
  }

  const chartData =
    data?.timeline.map((point) => {
      const date = parse(point.bucket, "yyyy-MM-dd", new Date());
      const label =
        granularity === PR_TIMELINE_GRANULARITY_OPTIONS.Week
          ? format(date, "MMM d")
          : format(date, "MMM yyyy");
      return { label, count: point.openedCount };
    }) ?? [];

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <p className="text-muted-foreground text-sm">
        Unable to load PR timeline data.
      </p>
    );
  }

  if (chartData.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No PR timeline data available for the selected range.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {(
            Object.values(PR_TIMELINE_RANGE_OPTIONS) as PrTimelineRangeOption[]
          ).map((days) => (
            <Button
              className={days === rangeDays ? "bg-accent" : ""}
              key={days}
              onClick={() => handleRangeChange(days)}
              size="sm"
              variant="outline"
            >
              {days}d
            </Button>
          ))}
        </div>
        <div className="flex gap-1">
          {(
            [
              PR_TIMELINE_GRANULARITY_OPTIONS.Week,
              PR_TIMELINE_GRANULARITY_OPTIONS.Month,
            ] as PrTimelineGranularity[]
          ).map((g) => (
            <Button
              className={g === granularity ? "bg-accent" : ""}
              key={g}
              onClick={() => handleGranularityChange(g)}
              size="sm"
              variant="outline"
            >
              {g === PR_TIMELINE_GRANULARITY_OPTIONS.Week ? "Week" : "Month"}
            </Button>
          ))}
        </div>
      </div>
      <ChartContainer className="h-48 w-full" config={chartConfig}>
        <BarChart data={chartData}>
          <XAxis dataKey="label" />
          <YAxis allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar
            dataKey="count"
            fill="var(--color-count)"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
    </div>
  );
}
