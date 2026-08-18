"use client";

import {
  LOSS_CLASS_LABELS,
  LOSS_CLASS_ORDER,
  type LostWorkTrendPoint,
} from "@repo/api/src/types/session-analytics";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { WidgetUnavailable } from "@/lib/analytics/unavailable";

/**
 * Lost wall-clock over time, split by cause class. The question a manager asks
 * is "is this getting worse", not "what happened", so the trend gets a
 * full-width block rather than a tile.
 *
 * Splitting the classes is what makes a bad day readable: an org-wide throttle
 * shows up as a systemic band across the whole team on one day, instead of six
 * people appearing to fail at once.
 */

export const TREND_UNAVAILABLE_REASON =
  "The daily rollup did not load for this range, so the trend is unavailable rather than flat.";

const CHART_HEIGHT_CLASS = "h-72";

type LossTrendProps = {
  readonly loading: boolean;
  /** `null` when the trend rollup settled without a value. */
  readonly trend: readonly LostWorkTrendPoint[] | null;
};

export function LossTrend({ loading, trend }: LossTrendProps) {
  return (
    <Section
      description="Hours in sessions that yielded no artifact, by what caused the loss."
      title="Lost wall-clock over time"
    >
      <TrendBody loading={loading} trend={trend} />
    </Section>
  );
}

function TrendBody({ loading, trend }: LossTrendProps) {
  if (loading) {
    // A skeleton at the chart's real height, so the page does not jump when the
    // series land.
    return <Skeleton className={`${CHART_HEIGHT_CLASS} w-full rounded-md`} />;
  }
  if (!trend) {
    return <WidgetUnavailable reason={TREND_UNAVAILABLE_REASON} />;
  }
  return (
    <div className={CHART_HEIGHT_CLASS}>
      <TimeSeriesAreaChart
        allowDecimals
        emptyMessage="No sessions in this range."
        // The wire series are deliberately unrounded: rounding each of 30 daily
        // buckets let the drift accumulate to minutes, so the charted series no
        // longer summed to the headline it is split from. Display rounding
        // happens once, in the formatter below.
        points={trend.map((point) => ({
          date: point.date,
          values: { ...point.values },
        }))}
        series={LOSS_CLASS_ORDER.map((lossClass) => ({
          key: lossClass,
          label: LOSS_CLASS_LABELS[lossClass],
        }))}
        valueFormatter={formatHoursTick}
      />
    </div>
  );
}

const TICK_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function formatHoursTick(value: number): string {
  return `${TICK_FORMATTER.format(value)} h`;
}
