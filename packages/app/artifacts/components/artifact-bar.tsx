"use client";

import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { ComponentProps } from "react";

export type ArtifactBarMetric = {
  key: string;
  label: string;
  value: ComponentProps<typeof MetricCard>["value"];
  info?: ComponentProps<typeof MetricCard>["info"];
  detail?: ComponentProps<typeof MetricCard>["detail"];
  sparkline?: ComponentProps<typeof MetricCard>["sparkline"];
  unitLabel?: ComponentProps<typeof MetricCard>["unitLabel"];
  loading?: ComponentProps<typeof MetricCard>["loading"];
  muted?: ComponentProps<typeof MetricCard>["muted"];
};

/** Shared artifact metric presentation; each host owns its data and scope. */
export function ArtifactBar({
  metrics,
  visibleMetricKeys,
}: {
  metrics: readonly ArtifactBarMetric[];
  visibleMetricKeys: ReadonlySet<string>;
}) {
  return (
    <div className="sticky left-0 px-4 pt-4 pb-3">
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 md:snap-none">
        {metrics
          .filter((metric) => visibleMetricKeys.has(metric.key))
          .map(({ key, ...metric }) => (
            <MetricCard
              {...metric}
              className="shrink-0 basis-[calc(100%_-_2.5rem)] snap-start md:min-w-44 md:flex-1 md:basis-auto"
              key={key}
              sparklineWithoutDelta
            />
          ))}
      </div>
    </div>
  );
}
