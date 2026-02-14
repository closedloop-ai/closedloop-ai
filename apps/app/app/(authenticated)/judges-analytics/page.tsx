"use client";

import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { format, subDays } from "date-fns";
import { useState } from "react";
import { useJudgesAnalytics } from "@/hooks/queries/use-judges-analytics";
import { ArtifactTypeSection } from "./components/artifact-type-section";
import { ArtifactsCreatedChart } from "./components/artifacts-created-chart";
import { DateRangeFilter } from "./components/date-range-filter";

export default function JudgesAnalyticsPage() {
  // Initialize date state with Month preset default (last 30 days)
  const [startDate, setStartDate] = useState<string>(() =>
    format(subDays(new Date(), 30), "yyyy-MM-dd")
  );
  const [endDate, setEndDate] = useState<string>(() =>
    format(new Date(), "yyyy-MM-dd")
  );

  // Fetch analytics data
  const { data, isLoading, isError, error } = useJudgesAnalytics(
    startDate,
    endDate
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      {/* Page title */}
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Judges</h1>
        <p className="text-muted-foreground">
          View aggregate statistics for LLM judge evaluations across artifact
          types.
        </p>
      </div>

      {/* Single date range filter for all charts and stats */}
      <DateRangeFilter
        endDate={endDate}
        onRangeChange={(start, end) => {
          setStartDate(start);
          setEndDate(end);
        }}
        startDate={startDate}
      />

      {/* Artifacts created bar chart (uses page date range, group by is chart-specific) */}
      <ArtifactsCreatedChart endDate={endDate} startDate={startDate} />

      {/* Content area with conditional rendering */}
      {isLoading && (
        <div className="space-y-8">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {isError && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
          <p className="font-medium text-destructive">
            Error loading analytics
          </p>
          <p className="text-muted-foreground text-sm">
            {error?.message || "An unexpected error occurred"}
          </p>
        </div>
      )}

      {data && data.groups.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/50 p-8 text-center">
          <p className="text-muted-foreground">
            No judge evaluations found for the selected date range.
          </p>
        </div>
      )}

      {data && data.groups.length > 0 && (
        <div className="space-y-8">
          {data.groups.map((group) => (
            <ArtifactTypeSection group={group} key={group.artifactType} />
          ))}
        </div>
      )}
    </div>
  );
}
