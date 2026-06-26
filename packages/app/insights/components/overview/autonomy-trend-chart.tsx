import type { TimeSeries } from "@repo/api/src/types/insights";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { SectionHeader } from "./section-header";

/**
 * "Autonomy Over Time" — daily median session-autonomy index (0 manual → 100
 * agentic) from the Agents insights (`autonomyTrend`). The index is the
 * agent-vs-human turn share per session; it's a SQL-derived trend, distinct
 * from the richer read-time autonomy score shown on session detail.
 */
export function AutonomyTrendChart({
  series,
}: {
  series: TimeSeries | undefined;
}) {
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        description="Median session autonomy · 0 = manual, 50 = mixed, 100 = agentic"
        title="Autonomy Over Time"
      />
      <div className="min-h-0 flex-1">
        {series ? (
          <TimeSeriesAreaChart
            emptyMessage="No autonomy data in range yet"
            points={series.points}
            series={series.series}
          />
        ) : (
          <Skeleton className="h-full w-full" />
        )}
      </div>
    </div>
  );
}
