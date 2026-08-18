"use client";

import type { TimeSeries } from "@repo/api/src/types/insights";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { useMemo, useState } from "react";
import { useChartMaxSeries } from "../../../shared/lib/use-chart-max-series";
import { SectionHeader } from "./section-header";
import {
  groupByProvider,
  UsageGraphControls,
  UsageGrouping,
  UsageMetric,
  usageMetricPresentation,
  usageOtherSeriesLabel,
} from "./usage-graph-toggles";

// Dashboard-specific copy per metric (title, description, empty/unavailable
// messages). The toggle controls, provider attribution, value formatter, and
// decimal policy are the SHARED "usage by" set reused from
// `usage-graph-toggles` (FEA-4027) so this graph and the Agents component-detail
// token-trend graph can't drift.
const METRIC_COPY: Record<
  UsageMetric,
  {
    title: string;
    description: string;
    emptyMessage: string;
    // Shown when this metric's series is a valid terminal absence (the producer
    // omitted the optional field) rather than "measured, but empty" — see the
    // state machine in ModelUsageChart. Distinct copy so the surface never
    // claims "no usage in range" when the truth is "this range's producer never
    // reported token usage at all". Tokens-only: spend (`series`) is the whole
    // card's load sentinel, so its own absence always reads as loading, never
    // "unavailable" — the cost metric can never reach the unavailable state, so
    // it carries no such copy (that copy would be structurally unreachable dead
    // code).
    unavailableMessage?: string;
  }
> = {
  [UsageMetric.Cost]: {
    // Sentence case, matching the tile catalog's entry for this same chart
    // (review thread): the catalog said "Model cost over time" while the chart's
    // own header and the expand label said Title Case, so one chart carried two
    // capitalizations across the grid and the modal.
    title: "Model cost over time",
    // "incl. subscription-covered" trailed off — abbreviating "including" cost
    // the sentence its noun (review thread).
    description: "Daily estimated cost by model, including subscription usage",
    emptyMessage: "No model cost in range yet",
  },
  [UsageMetric.Tokens]: {
    title: "Model usage over time",
    description: "Daily token usage by model",
    emptyMessage: "No model usage in range yet",
    unavailableMessage: "Token usage wasn't recorded for this range",
  },
};

// The empty `TimeSeries` fed to the shared chart to render the design-system
// dashed empty-state (via its `emptyMessage`) for the "unavailable" terminal
// state. Reusing the chart's own empty path keeps the surface — dashed panel,
// tokens, spacing — identical to a genuinely-empty range, and never a skeleton.
const EMPTY_SERIES: TimeSeries = { series: [], points: [] };

/**
 * The shared stacked time-series chart fed by the Agents insights, with two
 * toggles: a $/# metric toggle (FEA-3497) that flips the chart between estimated
 * USD spend (`modelUsageOverTime`) and token volume (`modelTokensOverTime`), and
 * a By model / By provider grouping toggle that re-aggregates the model series
 * into providers client-side. Both series share the same model keys/colors so
 * the metric toggle only swaps y-values. FEA-2331: spend is cache-neutral (it
 * reflects where the money goes), while the token view surfaces the raw usage
 * that spend understates for cache-heavy harnesses.
 */
export function ModelUsageChart({
  series,
  tokenSeries,
}: {
  series: TimeSeries | undefined;
  // Additive (FEA-3497): older / version-skewed producers may omit the token
  // series. FEA-3699: absence is a valid *terminal* result, not a permanent
  // loading state — the # view resolves to an explicit "unavailable" empty-state
  // instead of a stuck skeleton (see the state machine below).
  tokenSeries?: TimeSeries | undefined;
}) {
  const [metric, setMetric] = useState<UsageMetric>(UsageMetric.Cost);
  const [grouping, setGrouping] = useState<UsageGrouping>(UsageGrouping.Model);
  const presentation = usageMetricPresentation(metric);
  // ISS-5523: undefined until the gate opens, which leaves the chart drawing
  // every model exactly as it does today.
  const maxSeries = useChartMaxSeries();
  const copy = METRIC_COPY[metric];
  const activeSeries = metric === UsageMetric.Tokens ? tokenSeries : series;

  // FEA-3699 — resolve the active view to one of three terminal render states.
  // `series` (spend) is the load sentinel for the whole card: the API always
  // emits `modelUsageOverTime`, so its absence means the request is still in
  // flight. Once spend has arrived, an absent optional field (`tokenSeries`) is
  // a *completed* result, not loading — so we must not show a skeleton for it.
  //   - loading:     the active view's own series is absent AND spend hasn't
  //                  arrived yet → skeleton.
  //   - unavailable: the active view's own series is absent but spend HAS
  //                  arrived → the producer omitted this optional field. Render
  //                  the chart's own empty-state with explicit "unavailable"
  //                  copy. We do NOT fall back to the sibling metric's series:
  //                  spend USD and token counts are different quantities, so
  //                  reusing one for the other would be a lying UI.
  //   - resolved:    the active view has a defined series (possibly empty, zero,
  //                  or malformed) → hand it to the chart, which renders its own
  //                  "no data" empty-state for empty/all-zero and treats missing
  //                  per-bucket keys as 0. No NaN/undefined leaks to the DOM.
  const isLoading = !(activeSeries || series);
  // Active view's own series is absent, yet spend has already arrived — the
  // producer omitted this optional field. A completed absence, not loading.
  const isUnavailable = !activeSeries && Boolean(series);

  const chart = useMemo(() => {
    const source = activeSeries ?? (isUnavailable ? EMPTY_SERIES : undefined);
    if (!source) {
      return undefined;
    }
    return grouping === UsageGrouping.Provider
      ? groupByProvider(source)
      : source;
  }, [activeSeries, grouping, isUnavailable]);

  return (
    <div className="flex h-full flex-col">
      <SectionHeader description={copy.description} title={copy.title} />
      {/* Controls row: $/# metric on the left, model/provider grouping on the
          right — the shared "usage by" toggle set (FEA-4027). */}
      <UsageGraphControls
        grouping={grouping}
        metric={metric}
        onGroupingChange={setGrouping}
        onMetricChange={setMetric}
      />
      <div className="min-h-0 flex-1">
        {isLoading || !chart ? (
          <Skeleton className="h-full w-full" />
        ) : (
          <TimeSeriesAreaChart
            allowDecimals={presentation.allowDecimals}
            // Genuinely-empty/all-zero ranges read "no usage in range"; a
            // producer-omitted optional field reads the distinct "unavailable"
            // copy so the surface never lies about why the panel is empty.
            emptyMessage={
              isUnavailable
                ? (copy.unavailableMessage ?? copy.emptyMessage)
                : copy.emptyMessage
            }
            // FEA-3623: key by metric (and grouping) so flipping $ spend ↔ #
            // tokens remounts the chart. The spend and token series share the
            // same model keys and colors — only the y-values differ — so
            // React/Recharts reconciles the persisted <AreaChart> in place and
            // reuses its cached per-series y-scale + area paths, leaving the
            // plot on the previous metric even though `points` changed. The
            // header title and value formatter DO update (they read straight
            // from `metric`), so the stale plot reads as "the toggle does
            // nothing". Keying by metric forces a fresh chart per dataset; the
            // magnitude gap ($1.50 vs 1.5M) makes the reused-scale staleness
            // especially visible. Grouping stays in the key so By model ↔ By
            // provider keeps repainting too. FEA-3699: the unavailable flag
            // joins the key so the empty "unavailable" chart remounts (not
            // reconciles) into a populated one when a late/optional series
            // arrives, dodging the same stale-scale trap.
            key={`${metric}-${grouping}-${isUnavailable ? "na" : "ok"}`}
            maxSeries={maxSeries}
            otherSeriesLabel={usageOtherSeriesLabel(grouping)}
            points={chart.points}
            series={chart.series}
            valueFormatter={presentation.formatValue}
          />
        )}
      </div>
    </div>
  );
}
