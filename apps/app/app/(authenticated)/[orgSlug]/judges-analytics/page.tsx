"use client";

import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { useJudgesAnalytics } from "@repo/app/judges-analytics/hooks/use-judges-analytics";
import {
  JUDGES_ANALYTICS_DATE_RANGE_DAYS,
  JUDGES_ANALYTICS_DEFAULT_PRESET,
  JudgesAnalyticsDateRangePreset,
  judgesAnalyticsAllTimeRange,
} from "@repo/app/judges-analytics/lib/judges-analytics";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { format, subDays } from "date-fns";
import { SearchX } from "lucide-react";
import { useState } from "react";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { DateRangeFilter } from "./components/date-range-filter";
import { ReportTypeSection } from "./components/report-type-section";

function JudgesAnalyticsContent() {
  // Judges opens on the default preset (Month, last 30 days). When that window
  // is empty, the empty state offers a one-click widen to All time rather than
  // stranding the user on a dead-end "no evaluations" message.
  const [startDate, setStartDate] = useState<string>(() =>
    format(
      subDays(
        new Date(),
        JUDGES_ANALYTICS_DATE_RANGE_DAYS[JUDGES_ANALYTICS_DEFAULT_PRESET]
      ),
      "yyyy-MM-dd"
    )
  );
  const [endDate, setEndDate] = useState<string>(() =>
    format(new Date(), "yyyy-MM-dd")
  );
  const [activePreset, setActivePreset] =
    useState<JudgesAnalyticsDateRangePreset>(JUDGES_ANALYTICS_DEFAULT_PRESET);

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

  // The error branch takes precedence over the resolved-content branches:
  // cached data survives a failed TanStack refetch, so all three queries can
  // still expose `data` (making the page look resolved-and-empty) while
  // `isError` is true. Deriving resolved content from `!isError` keeps a failed
  // request from rendering the error Alert and "No evaluations" together.
  const allResolved =
    !isError && Boolean(planQuery.data && prdQuery.data && codeQuery.data);
  const hasData =
    (planQuery.data?.groups.length ?? 0) > 0 ||
    (prdQuery.data?.groups.length ?? 0) > 0 ||
    (codeQuery.data?.groups.length ?? 0) > 0;
  const isEmpty = allResolved && !hasData;
  const canWiden = activePreset !== JudgesAnalyticsDateRangePreset.All;

  const handleRangeChange = (
    start: string,
    end: string,
    preset: JudgesAnalyticsDateRangePreset
  ) => {
    setStartDate(start);
    setEndDate(end);
    setActivePreset(preset);
  };

  const handleShowAllTime = () => {
    const { start, end, preset } = judgesAnalyticsAllTimeRange();
    handleRangeChange(start, end, preset);
  };

  return (
    <>
      {/* Single date range filter for all charts and stats */}
      <DateRangeFilter
        activePreset={activePreset}
        endDate={endDate}
        onRangeChange={handleRangeChange}
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
        <Alert variant="error">
          <AlertTitle>Error loading analytics</AlertTitle>
          <AlertDescription>
            {error?.message || "An unexpected error occurred"}
          </AlertDescription>
        </Alert>
      )}

      {isEmpty && canWiden && (
        <EmptyState
          action={
            <Button onClick={handleShowAllTime} variant="outline">
              Show all time
            </Button>
          }
          description="There are no judge evaluations in the selected date range."
          icon={SearchX}
          title="No evaluations in this range"
        />
      )}

      {isEmpty && !canWiden && (
        <EmptyState
          description="No judge evaluations have been recorded yet. They appear here once artifacts are evaluated."
          icon={SearchX}
          title="No judge evaluations found"
        />
      )}

      {allResolved && hasData && (
        <div className="space-y-8">
          <ReportTypeSection
            groups={planQuery.data?.groups ?? []}
            reportType={EvaluationReportType.Plan}
          />
          <ReportTypeSection
            groups={prdQuery.data?.groups ?? []}
            reportType={EvaluationReportType.Prd}
          />
          <ReportTypeSection
            groups={codeQuery.data?.groups ?? []}
            reportType={EvaluationReportType.Code}
          />
        </div>
      )}
    </>
  );
}

/**
 * ISS-5037: what the Judges body shows while the Labs container flag is still
 * resolving — the same three-section skeleton the page's own `isLoading` branch
 * uses, so the gate resolving open is a no-op on screen rather than a blank
 * region popping into content.
 */
function JudgesBodySkeleton() {
  return (
    <div
      aria-label="Loading judge analytics"
      aria-live="polite"
      className="space-y-8"
      role="status"
    >
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * ISS-5037 (ISS-4779 closed-by-default): Judges is a Labs destination, so the
 * route is gated on the same container flag that hides the Labs nav section.
 * Hiding the nav link while leaving this URL reachable would defeat the gate —
 * with the flag off a direct visit lands on the in-shell "Page not found"
 * recovery state via `notFound()`, matching how Insights degrades.
 *
 * The page CHROME (the frame, the `<h1>`, and the description) sits OUTSIDE the
 * gate on purpose: it is identical whether or not Labs is on, and gating it too
 * left the whole route rendering an empty region until PostHog settled. Only
 * the Labs-gated CONTENT is inside, with a skeleton for the resolving window.
 */
export default function JudgesAnalyticsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Judges</h1>
        <p className="text-muted-foreground">
          View aggregate statistics for LLM judge evaluations across artifact
          types.
        </p>
      </div>
      <FeatureFlagRouteGate
        flag={LABS_NAV_SECTION_FEATURE_FLAG_KEY}
        pending={<JudgesBodySkeleton />}
      >
        <JudgesAnalyticsContent />
      </FeatureFlagRouteGate>
    </div>
  );
}
