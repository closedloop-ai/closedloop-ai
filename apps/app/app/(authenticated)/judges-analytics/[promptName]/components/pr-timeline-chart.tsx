"use client";

import { analytics } from "@repo/analytics";
import {
  PR_TIMELINE_GRANULARITY_OPTIONS,
  PR_TIMELINE_RANGE_OPTIONS,
  type PrHealthResponse,
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
import { Bar, BarChart, XAxis, YAxis } from "recharts";

type PrTimelineChartProps = {
  data: PrHealthResponse | undefined;
  granularity: PrTimelineGranularity;
  isError: boolean;
  isLoading: boolean;
  onGranularityChange: (g: PrTimelineGranularity) => void;
  onRangeChange: (days: PrTimelineRangeOption) => void;
  promptName: string;
  rangeDays: PrTimelineRangeOption;
};

const chartConfig: ChartConfig = {
  count: {
    label: "PRs",
    color: "var(--chart-1)",
  },
};

export function PrTimelineChart({
  data,
  granularity,
  isError,
  isLoading,
  onGranularityChange,
  onRangeChange,
  promptName,
  rangeDays,
}: PrTimelineChartProps) {
  const { orgId, userId } = useAuth();

  function handleRangeChange(days: PrTimelineRangeOption) {
    onRangeChange(days);
    analytics.capture("PR Timeline Date Range Changed", {
      organization_id: orgId,
      user_id: userId,
      judge_prompt_name: promptName,
      range_days: days,
    });
  }

  function handleGranularityChange(g: PrTimelineGranularity) {
    onGranularityChange(g);
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

  const rangeGranularityButtons = (
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
  );

  return (
    <div className="space-y-4">
      {rangeGranularityButtons}
      {chartData.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No PR timeline data available for the selected range.
        </p>
      ) : (
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
      )}
    </div>
  );
}
