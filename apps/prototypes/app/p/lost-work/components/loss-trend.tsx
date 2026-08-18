"use client";

import { Section } from "@repo/design-system/components/ui/layout/section";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { DataState } from "@/lib/analytics/format";
import {
  LOSS_CLASS_LABELS,
  LOSS_CLASS_ORDER,
} from "@/lib/analytics/session-fixture";
import { orgUsageLimitDate, trendPoints } from "../mock";

/**
 * Lost wall-clock over time, split by cause class. The question the product
 * owner asked is "is this getting worse", not "what happened", so the trend
 * gets a full-width block rather than a tile.
 *
 * The org-wide usage-limit day is annotated on the axis. That is the payoff of
 * splitting the classes: the spike shows up as a systemic band across the whole
 * team on one day, instead of six people appearing to fail at once.
 */

const CHART_HEIGHT_CLASS = "h-72";

export function LossTrend({ dataState }: { readonly dataState: DataState }) {
  return (
    <Section
      description="Hours in sessions that yielded no artifact, by what caused the loss."
      title="Lost wall-clock over time"
    >
      {dataState === DataState.Loading ? (
        // A skeleton at the chart's real height, so the page does not jump when
        // the series land.
        <Skeleton className={`${CHART_HEIGHT_CLASS} w-full rounded-md`} />
      ) : (
        <div className={CHART_HEIGHT_CLASS}>
          <TimeSeriesAreaChart
            allowDecimals
            markers={[
              {
                date: orgUsageLimitDate,
                description:
                  "Org-wide usage limit reached. Every engineer lost a run on this day, so the loss is systemic and none of it is coachable.",
                label: "Org usage limit",
              },
            ]}
            points={[...trendPoints]}
            series={LOSS_CLASS_ORDER.map((lossClass) => ({
              key: lossClass,
              label: LOSS_CLASS_LABELS[lossClass],
            }))}
            valueFormatter={formatHoursTick}
          />
        </div>
      )}
    </Section>
  );
}

const TICK_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function formatHoursTick(value: number): string {
  return `${TICK_FORMATTER.format(value)} h`;
}
