"use client";

import type { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { ARTIFACT_SUBTYPE_OPTIONS } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { format, parse, subDays } from "date-fns";
import { useMemo, useState } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import type { ArtifactCountsGroupBy } from "@/hooks/queries/use-judges-analytics";
import { useArtifactCounts } from "@/hooks/queries/use-judges-analytics";
import { ARTIFACT_SUBTYPE_LABELS } from "@/lib/project-constants";

const ALL_TIME_START = "2000-01-01";

/** Parse "yyyy-MM-dd" as local midnight (not UTC) */
const toLocalDate = (dateStr: string) =>
  parse(dateStr, "yyyy-MM-dd", new Date());

function formatBucketLabel(
  bucket: string,
  groupBy: ArtifactCountsGroupBy
): string {
  const d = parse(bucket, "yyyy-MM-dd", new Date());
  switch (groupBy) {
    case "day":
      return format(d, "MMM d");
    case "week":
      return `Week of ${format(d, "MMM d")}`;
    case "month":
      return format(d, "MMM yyyy");
    default:
      return bucket;
  }
}

const CHART_COLORS = 5;

export function ArtifactsCreatedChart() {
  const [startDate, setStartDate] = useState<string>(() =>
    format(subDays(new Date(), 30), "yyyy-MM-dd")
  );
  const [endDate, setEndDate] = useState<string>(() =>
    format(new Date(), "yyyy-MM-dd")
  );
  const [groupBy, setGroupBy] = useState<ArtifactCountsGroupBy>("day");
  const [activePreset, setActivePreset] = useState<
    "week" | "month" | "year" | "all" | "custom" | null
  >("month");

  const { data, isLoading, isError, error } = useArtifactCounts(
    startDate,
    endDate,
    groupBy
  );

  const handlePresetClick = (
    preset: "week" | "month" | "year",
    days: number
  ) => {
    const end = new Date();
    const start = subDays(end, days);
    setActivePreset(preset);
    setStartDate(format(start, "yyyy-MM-dd"));
    setEndDate(format(end, "yyyy-MM-dd"));
  };

  const handleAllTimeClick = () => {
    setActivePreset("all");
    setStartDate(ALL_TIME_START);
    setEndDate(format(new Date(), "yyyy-MM-dd"));
  };

  const handleCustomDateChange = (
    dateType: "start" | "end",
    date: Date | null
  ) => {
    setActivePreset("custom");
    if (dateType === "start" && date) {
      setStartDate(format(date, "yyyy-MM-dd"));
    } else if (dateType === "end" && date) {
      setEndDate(format(date, "yyyy-MM-dd"));
    }
  };

  const { chartData, chartConfig, subtypeKeys } = useMemo(() => {
    if (!data?.buckets?.length) {
      return {
        chartData: [] as Record<string, string | number>[],
        chartConfig: {} as ChartConfig,
        subtypeKeys: [] as string[],
      };
    }
    const keySet = new Set<string>();
    for (const b of data.buckets) {
      for (const subtype of Object.keys(b.countsBySubtype ?? {})) {
        keySet.add(subtype);
      }
    }
    const subtypeKeys = [...keySet].sort(
      (a, b) =>
        ARTIFACT_SUBTYPE_OPTIONS.indexOf(a as ArtifactSubtype) -
        ARTIFACT_SUBTYPE_OPTIONS.indexOf(b as ArtifactSubtype)
    );
    const chartConfig: ChartConfig = {};
    for (let i = 0; i < subtypeKeys.length; i++) {
      const subtype = subtypeKeys[i];
      const colorIndex = (i % CHART_COLORS) + 1;
      chartConfig[subtype] = {
        label: ARTIFACT_SUBTYPE_LABELS[subtype] ?? subtype,
        color: `var(--chart-${colorIndex})`,
      };
    }
    const chartData = data.buckets.map((b) => {
      const row: Record<string, string | number> = {
        label: formatBucketLabel(b.bucket, groupBy),
      };
      for (const subtype of subtypeKeys) {
        row[subtype] = b.countsBySubtype[subtype] ?? 0;
      }
      return row;
    });
    return { chartData, chartConfig, subtypeKeys };
  }, [data?.buckets, groupBy]);

  return (
    <section className="space-y-4">
      <h2 className="font-semibold text-xl">Artifacts created</h2>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex gap-2">
          <Button
            className={activePreset === "week" ? "bg-accent" : ""}
            onClick={() => handlePresetClick("week", 7)}
            variant="outline"
          >
            Week
          </Button>
          <Button
            className={activePreset === "month" ? "bg-accent" : ""}
            onClick={() => handlePresetClick("month", 30)}
            variant="outline"
          >
            Month
          </Button>
          <Button
            className={activePreset === "year" ? "bg-accent" : ""}
            onClick={() => handlePresetClick("year", 365)}
            variant="outline"
          >
            Year
          </Button>
          <Button
            className={activePreset === "all" ? "bg-accent" : ""}
            onClick={handleAllTimeClick}
            variant="outline"
          >
            All time
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Custom:</span>
          <DatePickerPopover
            onSelect={(date) => handleCustomDateChange("start", date)}
            placeholder="Start date"
            toDate={endDate ? toLocalDate(endDate) : new Date()}
            value={startDate ? toLocalDate(startDate) : null}
          />
          <span className="text-muted-foreground">to</span>
          <DatePickerPopover
            fromDate={startDate ? toLocalDate(startDate) : undefined}
            onSelect={(date) => handleCustomDateChange("end", date)}
            placeholder="End date"
            toDate={new Date()}
            value={endDate ? toLocalDate(endDate) : null}
          />
        </div>

        <div className="flex items-center gap-2 border-border border-l pl-4">
          <span className="text-muted-foreground text-sm">Group by:</span>
          <div className="flex gap-1">
            {(["day", "week", "month"] as const).map((value) => (
              <Button
                className={groupBy === value ? "bg-accent" : ""}
                key={value}
                onClick={() => setGroupBy(value)}
                variant="outline"
              >
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {isLoading && <Skeleton className="h-64 w-full" />}

      {isError && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
          <p className="font-medium text-destructive">
            Error loading artifact counts
          </p>
          <p className="text-muted-foreground text-sm">
            {error?.message || "An unexpected error occurred"}
          </p>
        </div>
      )}

      {!(isLoading || isError) &&
        (chartData.length === 0 || subtypeKeys.length === 0) && (
          <div className="rounded-lg border border-border bg-muted/50 p-8 text-center">
            <p className="text-muted-foreground">
              No artifacts created in this range.
            </p>
          </div>
        )}

      {!(isLoading || isError) &&
        chartData.length > 0 &&
        subtypeKeys.length > 0 && (
          <ChartContainer className="h-64 w-full" config={chartConfig}>
            <BarChart
              accessibilityLayer
              aria-label="Artifacts created per period by type"
              data={chartData}
              margin={{ bottom: 60, left: 20, right: 30, top: 20 }}
            >
              <ChartLegend
                content={<ChartLegendContent verticalAlign="top" />}
                verticalAlign="top"
              />
              <XAxis
                angle={-45}
                dataKey="label"
                height={80}
                interval={0}
                textAnchor="end"
                tick={{ fontSize: 12 }}
              />
              <YAxis
                allowDecimals={false}
                label={{
                  value: "Count",
                  angle: -90,
                  position: "insideLeft",
                }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              {subtypeKeys.map((subtype) => (
                <Bar
                  dataKey={subtype}
                  fill={`var(--color-${subtype})`}
                  key={subtype}
                  radius={[4, 4, 0, 0]}
                />
              ))}
            </BarChart>
          </ChartContainer>
        )}
    </section>
  );
}
