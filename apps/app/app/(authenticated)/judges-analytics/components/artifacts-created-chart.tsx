"use client";

import type { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { ARTIFACT_SUBTYPE_OPTIONS } from "@repo/api/src/types/artifact";
import {
  ARTIFACT_COUNTS_GROUP_BY_OPTIONS,
  type ArtifactCountsGroupBy,
} from "@repo/api/src/types/judges-analytics";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { format, parse } from "date-fns";
import { useMemo, useState } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { useArtifactCounts } from "@/hooks/queries/use-judges-analytics";
import { ARTIFACT_SUBTYPE_LABELS } from "@/lib/project-constants";

type ArtifactsCreatedChartProps = {
  startDate: string;
  endDate: string;
};

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

export function ArtifactsCreatedChart({
  startDate,
  endDate,
}: ArtifactsCreatedChartProps) {
  const [groupBy, setGroupBy] = useState<ArtifactCountsGroupBy>("day");

  const { data, isLoading, isError, error } = useArtifactCounts(
    startDate,
    endDate,
    groupBy
  );

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
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Group by:</span>
          <div className="flex gap-1">
            {ARTIFACT_COUNTS_GROUP_BY_OPTIONS.map((value) => (
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
