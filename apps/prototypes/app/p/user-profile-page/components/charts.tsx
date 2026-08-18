"use client";

import { DonutChart } from "@repo/design-system/components/ui/donut-chart";
import { ActivityHeatmap } from "@repo/design-system/components/ui/primitives/activity-heatmap";
import type { AnalyticsHeatmapWeek } from "@repo/design-system/components/ui/types";
import { formatCompactNumber } from "@repo/design-system/components/ui/utils";
import type { ModelSlice } from "../mock";
import { WidgetCard } from "./widget-card";

// The two substance cards the brag wall keeps: the token-breakdown donut (reads
// as a fact, not a trend) and the contribution heatmap. Both mirror an existing
// Insights overview widget's title/description rhythm on the same design-system
// chart primitives (DonutChart, ActivityHeatmap). The four trend charts (model
// usage / autonomy / spend over time, event heatmap) were cut in review — trend
// exploration belongs on Insights filtered by user, not on a glanceable profile.

export function TokenBreakdownCard({
  data,
  windowLabel,
}: {
  data: ModelSlice[];
  // States the range the donut is actually showing (#4285 review: the card
  // ignored the page's range control entirely), so the title never claims a
  // window other than the one the data was scoped to.
  windowLabel: string;
}) {
  return (
    <WidgetCard
      description="Input, output, and cache across all models"
      title={`Token Breakdown · ${windowLabel}`}
    >
      <div className="h-72">
        <DonutChart data={data} valueFormatter={formatCompactNumber} />
      </div>
    </WidgetCard>
  );
}

function summarizeHeatmap(
  weeks: AnalyticsHeatmapWeek[],
  valueFormatter: (count: number) => string
): string {
  const cells = weeks.flat();
  const total = cells.reduce((sum, cell) => sum + cell.count, 0);
  const activeDays = cells.filter((cell) => cell.count > 0).length;
  const busiest = cells.reduce(
    (best, cell) => (cell.count > best.count ? cell : best),
    { date: "", count: 0 }
  );
  const busiestText = busiest.count
    ? ` Busiest day: ${busiest.date}, ${valueFormatter(busiest.count)}.`
    : "";
  return `${valueFormatter(total)} total across ${activeDays} active days.${busiestText}`;
}

export function HeatmapCard({
  title,
  description,
  weeks,
  valueFormatter = (count) => count.toLocaleString(),
}: {
  title: string;
  description: string;
  weeks: AnalyticsHeatmapWeek[];
  valueFormatter?: (count: number) => string;
}) {
  // ActivityHeatmap's ramp is now tokenized (opacity over --primary, theme-aware)
  // and its cells are focusable, labeled gridcells (FEA-4063), so the primitive
  // reads correctly on light and dark and is keyboard/SR-inspectable. The
  // visually-hidden text summary stays as a concise aggregate alternative to the
  // per-cell grid.
  return (
    <WidgetCard description={description} title={title}>
      <div className="overflow-x-auto pb-1">
        <ActivityHeatmap
          label={title}
          valueFormatter={valueFormatter}
          weeks={weeks}
        />
        <p className="sr-only">{summarizeHeatmap(weeks, valueFormatter)}</p>
      </div>
    </WidgetCard>
  );
}
