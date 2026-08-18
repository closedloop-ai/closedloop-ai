"use client";

import type { ContributionDay } from "@repo/api/src/types/user";
import { ActivityHeatmap } from "@repo/design-system/components/ui/primitives/activity-heatmap";
import type { AnalyticsHeatmapWeek } from "@repo/design-system/components/ui/types";
import { useMemo } from "react";

type ContributionHeatmapProps = {
  data: ContributionDay[];
};

// The profile series is document-artifact creations per day (apps/api users
// service), so "contributions" reads as those. Contributions render on the
// green --success token rather than --primary so the graph reads as activity,
// not as the loudest button-colored block on a screen of stat tiles.
const CONTRIBUTION_ACCENT_VAR = "--success";
const HEATMAP_LABEL = "Contributions by day";

function formatContributions(count: number): string {
  return `${count.toLocaleString()} contribution${count === 1 ? "" : "s"}`;
}

// Group the flat daily series into Sunday-started week columns, the shape the
// design-system ActivityHeatmap consumes (one inner array per column). The
// primitive offsets the leading partial week from each column's first weekday,
// so a non-Sunday-aligned server range still lands each day under the right row.
function groupIntoWeeks(data: ContributionDay[]): AnalyticsHeatmapWeek[] {
  const weeks: AnalyticsHeatmapWeek[] = [];
  let current: AnalyticsHeatmapWeek = [];

  for (const day of data) {
    const dayOfWeek = new Date(`${day.date}T12:00:00Z`).getUTCDay();
    if (dayOfWeek === 0 && current.length > 0) {
      weeks.push(current);
      current = [];
    }
    current.push({ date: day.date, count: day.count });
  }
  if (current.length > 0) {
    weeks.push(current);
  }
  return weeks;
}

/**
 * Profile contribution graph. A thin domain adapter over the design-system
 * ActivityHeatmap primitive (FEA-4063): it maps the profile's ContributionDay
 * series onto the primitive's week-column shape and labels cells in
 * contributions. The tokenized, accessible ramp, per-cell tooltip, roving-focus
 * grid, and weekday-row semantics live in the primitive so web and desktop
 * share one heatmap — this replaces the former bespoke emerald grid that
 * hardcoded off-token Tailwind palette colors.
 */
export function ContributionHeatmap({ data }: ContributionHeatmapProps) {
  const weeks = useMemo(() => groupIntoWeeks(data), [data]);
  const hasContributions = useMemo(
    () => data.some((day) => day.count > 0),
    [data]
  );

  if (!hasContributions) {
    return (
      <p className="text-muted-foreground text-sm">No contributions yet</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <ActivityHeatmap
        accentVar={CONTRIBUTION_ACCENT_VAR}
        label={HEATMAP_LABEL}
        valueFormatter={formatContributions}
        weeks={weeks}
      />
    </div>
  );
}
