"use client";

import type { ComponentVersion } from "@repo/api/src/types/agent-component";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { useMemo, useState } from "react";
import {
  groupByProvider,
  UsageGraphControls,
  UsageGrouping,
  UsageMetric,
  usageMetricPresentation,
  usageOtherSeriesLabel,
} from "../../../insights/components/overview/usage-graph-toggles";
import { useChartMaxSeries } from "../../../shared/lib/use-chart-max-series";
import { useAgentComponentTokenTrend } from "../../hooks/use-agent-component-token-trend";
import {
  buildTokenTrendSeries,
  buildVersionMarkers,
  type UsageSessionVersion,
} from "../../lib/token-trend-chart-data";
import { resolveUsageSignal, UsageSignal } from "../../lib/usage-signal";

/**
 * Usage-trend chart for a single agent component (FEA-2923 / AC-018, extended by
 * FEA-4027 to dashboard parity).
 *
 * Consumes `useAgentComponentTokenTrend(slug)` (GET
 * /agent-components/{slug}/token-trend) and renders a stacked per-model
 * time-series with:
 *   - the SAME metric/grouping toggles as the dashboard's "usage by" graph —
 *     `UsageGraphControls` from the shared `usage-graph-toggles` module — so the
 *     series flips between tokens (# input+output) and dollars ($ estimated) and
 *     regroups by model or provider identically to the dashboard.
 *   - vertical version-lifecycle markers on the time axis: each revision's
 *     created day and the day it was first used, so a usage change can be read
 *     against the version rollout that caused it.
 */
export function TokenTrendChart({
  slug,
  versions,
  usageSessions,
  sessions,
}: {
  slug: string;
  versions: readonly ComponentVersion[];
  usageSessions: readonly UsageSessionVersion[];
  /**
   * The component's session count — the SAME number the Sessions card renders
   * above this chart. The empty state keys off it so the copy can never deny
   * usage the reader can already see on screen. Optional and null-tolerant: a
   * producer that cannot compute it sends `null` and a version-skewed payload may
   * omit it, and either way the copy falls to the `unknown` state rather than a
   * denial (ISS-5363). Attributed `usageSessions` still count as evidence of
   * usage on their own.
   */
  sessions?: number | null;
}) {
  const { data, isLoading, isError, error } = useAgentComponentTokenTrend(slug);
  const [metric, setMetric] = useState<UsageMetric>(UsageMetric.Tokens);
  const [grouping, setGrouping] = useState<UsageGrouping>(UsageGrouping.Model);
  const presentation = usageMetricPresentation(metric);
  // ISS-5523: undefined until the gate opens, which leaves the chart drawing
  // every model exactly as it does today.
  const maxSeries = useChartMaxSeries();

  const chart = useMemo(() => {
    const source = buildTokenTrendSeries(data, metric);
    return grouping === UsageGrouping.Provider
      ? groupByProvider(source)
      : source;
  }, [data, metric, grouping]);

  // ISS-4802: name the state the reader is actually in, for the metric they are
  // actually looking at. Two things were wrong with one flat string. First, the
  // chart has a $/# toggle, so metric-blind copy told a reader on $ that no
  // TOKEN usage was recorded — naming the wrong missing thing, since tokens are
  // exactly what that component does have. Second, "No usage recorded" denied
  // usage the Invocations and Sessions cards had already shown directly above.
  // `detail.sessions` is the count on those cards, so keying off it ties the
  // copy to a number the reader can see rather than to a roster they cannot.
  // ISS-5363 (wongk): `sessions ?? usageSessions.length` collapsed an UNMEASURED
  // count into the roster length, so a detail whose Sessions card reads `—`
  // printed "No usage recorded for this component yet" underneath it. The shared
  // three-state signal keeps the denial for the measured-zero case only.
  const emptyMessage =
    EMPTY_COPY[metric][resolveUsageSignal(sessions, usageSessions.length)];

  // Markers are version-scoped (not metric/grouping-scoped), so they persist
  // across toggles; the chart drops any that fall off the rendered window.
  const markers = useMemo(
    () => buildVersionMarkers(versions, usageSessions, data),
    [versions, usageSessions, data]
  );

  if (isLoading) {
    return <Skeleton className="h-56 w-full" />;
  }

  if (isError) {
    return (
      <p className="text-destructive text-sm">
        Failed to load token trend
        {error instanceof Error ? `: ${error.message}` : ""}.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <UsageGraphControls
        grouping={grouping}
        metric={metric}
        onGroupingChange={setGrouping}
        onMetricChange={setMetric}
      />
      <div className="h-56 w-full">
        <TimeSeriesAreaChart
          allowDecimals={presentation.allowDecimals}
          emptyMessage={emptyMessage}
          // Remount per metric/grouping so flipping $ ↔ # (a large magnitude
          // gap) never reuses a stale y-scale — the dashboard's FEA-3623 guard.
          key={`${metric}-${grouping}`}
          markers={markers}
          maxSeries={maxSeries}
          otherSeriesLabel={usageOtherSeriesLabel(grouping)}
          points={chart.points}
          series={chart.series}
          valueFormatter={presentation.formatValue}
        />
      </div>
    </div>
  );
}

/**
 * ISS-4802 — per-metric empty-state copy, mirroring the dashboard's
 * `METRIC_COPY` in `insights/components/overview/model-usage-chart.tsx` so the
 * two charts that share the $/# toggle cannot describe the same absence
 * differently.
 *
 * Two axes, because "nothing to plot" has two distinct causes and the reader
 * needs to be told which one they are looking at:
 *   - `none`: this component has no sessions at all, so there is genuinely
 *     nothing to attribute. The flat "no usage" statement is true.
 *   - `present`: the component HAS sessions — the count is on the card
 *     directly above this chart — but none of them carry a per-model rollup for
 *     THIS metric. Saying "no usage" here would contradict a number already on
 *     screen, so the copy names the missing attribution instead, and names it
 *     per metric: on $ the missing thing is spend, not tokens.
 *   - `unknown` (ISS-5363): the producer could not compute the session count at
 *     all, so the card above shows a dash. Neither of the statements above is
 *     true, so the copy states only what is certain — that this surface has no
 *     usage to show — without denying that usage exists.
 *
 * Voice matches the dashboard siblings ("No model spend in range yet"): short,
 * lowercase-after-first-word, no possessive clause in the middle.
 */
const EMPTY_COPY: Record<UsageMetric, Record<UsageSignal, string>> = {
  [UsageMetric.Cost]: {
    [UsageSignal.None]: "No usage recorded for this component yet",
    [UsageSignal.Present]: "No model spend attributed to these sessions yet",
    [UsageSignal.Unknown]: "Usage for this component isn't available here",
  },
  [UsageMetric.Tokens]: {
    [UsageSignal.None]: "No usage recorded for this component yet",
    [UsageSignal.Present]:
      "No model token usage attributed to these sessions yet",
    [UsageSignal.Unknown]: "Usage for this component isn't available here",
  },
};
