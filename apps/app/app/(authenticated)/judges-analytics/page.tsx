"use client";

import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { format, subDays } from "date-fns";
import { useState } from "react";
import { useJudgesAnalytics } from "@/hooks/queries/use-judges-analytics";
import { DateRangeFilter } from "./components/date-range-filter";
import { ReportTypeSection } from "./components/report-type-section";

export default function JudgesAnalyticsPage() {
  // Initialize date state with Month preset default (last 30 days)
  const [startDate, setStartDate] = useState<string>(() =>
    format(subDays(new Date(), 30), "yyyy-MM-dd")
  );
  const [endDate, setEndDate] = useState<string>(() =>
    format(new Date(), "yyyy-MM-dd")
  );

  const planQuery = useJudgesAnalytics(
    startDate,
    endDate,
    EvaluationReportType.Plan
  );
  const prdQuery = useJudgesAnalytics(
    startDate,
    endDate,
    EvaluationReportType.Prd
  );
  const codeQuery = useJudgesAnalytics(
    startDate,
    endDate,
    EvaluationReportType.Code
  );

  const isLoading =
    planQuery.isLoading || prdQuery.isLoading || codeQuery.isLoading;
  const isError = planQuery.isError || prdQuery.isError || codeQuery.isError;
  const error = planQuery.error ?? prdQuery.error ?? codeQuery.error;

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

      {planQuery.data &&
        prdQuery.data &&
        codeQuery.data &&
        planQuery.data.groups.length === 0 &&
        prdQuery.data.groups.length === 0 &&
        codeQuery.data.groups.length === 0 && (
          <div className="rounded-lg border border-border bg-muted/50 p-8 text-center">
            <p className="text-muted-foreground">
              No judge evaluations found for the selected date range.
            </p>
          </div>
        )}

      {planQuery.data &&
        prdQuery.data &&
        codeQuery.data &&
        (planQuery.data.groups.length > 0 ||
          prdQuery.data.groups.length > 0 ||
          codeQuery.data.groups.length > 0) && (
          <div className="space-y-8">
            <ReportTypeSection
              groups={planQuery.data.groups}
              reportType={EvaluationReportType.Plan}
            />
            <ReportTypeSection
              groups={prdQuery.data.groups}
              reportType={EvaluationReportType.Prd}
            />
            <ReportTypeSection
              groups={codeQuery.data.groups}
              reportType={EvaluationReportType.Code}
            />
          </div>
        )}
    </div>
  );
}
