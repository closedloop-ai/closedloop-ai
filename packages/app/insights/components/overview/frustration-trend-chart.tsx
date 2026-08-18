import type { TimeSeries } from "@repo/api/src/types/insights";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { SectionHeader } from "./section-header";

/**
 * "Frustration Over Time" — daily mean session frustration from the Agents
 * insights (`frustrationTrend`), normalized 0 (calm) → 100 (peak) against the
 * org population's observed max over the window. A SQL-derived, opt-in trend
 * (FEA-4022): the row is only rendered when the org enabled
 * `calculateSessionFrustration` AND the window has scored sessions.
 */
export function FrustrationTrendChart({
  series,
}: {
  series: TimeSeries | undefined;
}) {
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        description="Mean session frustration · 0 = calm, 100 = population peak"
        title="Frustration Over Time"
      />
      <div className="min-h-0 flex-1">
        {series ? (
          <TimeSeriesAreaChart
            // FEA-4022 (T8): offset the palette so this trend renders in
            // --chart-2, distinct from the Autonomy Over Time chart directly
            // above it (--chart-1). Both are single-series 0–100 trends with
            // OPPOSITE polarity (up = good for autonomy, up = bad here), so
            // sharing a color on the same axis would misread as one metric.
            colorOffset={1}
            emptyMessage="No frustration data in range yet"
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
