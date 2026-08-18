"use client";

import type { TimeSeries } from "@repo/api/src/types/insights";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { BoxIcon, DollarSignIcon, HashIcon, LayersIcon } from "lucide-react";
import { metricAllowsFractions, metricValueFormatter } from "../../lib/format";
import { providerOf } from "../../lib/model-provider";

/**
 * Shared usage-graph toggle set (FEA-4027).
 *
 * The metric ($ spend / # tokens) and grouping (by model / by provider) toggles
 * that were introduced on the dashboard's "usage by" graph (`ModelUsageChart`,
 * FEA-3497), lifted here so the Agents component-detail token-trend chart can
 * reuse the EXACT same controls, presentation, provider attribution, and value
 * formatting instead of re-declaring them. Both surfaces import `UsageMetric`,
 * `UsageGrouping`, `groupByProvider`, `usageMetricPresentation`, and render the
 * `UsageGraphControls` row — so the two "usage by" graphs can never drift.
 */

/** Which dimension the stacked series are grouped by. */
export const UsageGrouping = {
  Model: "model",
  Provider: "provider",
} as const;
export type UsageGrouping = (typeof UsageGrouping)[keyof typeof UsageGrouping];

/** Which quantity the chart stacks: estimated USD spend, or token volume. */
export const UsageMetric = {
  Cost: "cost",
  Tokens: "tokens",
} as const;
export type UsageMetric = (typeof UsageMetric)[keyof typeof UsageMetric];

// The grouping toggle options (By model / By provider).
const GROUPINGS: {
  key: UsageGrouping;
  label: string;
  Icon: typeof LayersIcon;
}[] = [
  { key: UsageGrouping.Model, label: "By model", Icon: LayersIcon },
  { key: UsageGrouping.Provider, label: "By provider", Icon: BoxIcon },
];

/**
 * Per-metric presentation shared by every "usage by" graph. Both metrics stack
 * the same series (same keys/colors); only the y-values, axis format, and copy
 * change. Spend is sub-dollar-capable so its axis needs fractional ticks; token
 * counts are whole integers formatted compactly ("1.2M"). Keyed by
 * {@link UsageMetric} so a consumer resolves its formatter, decimal policy, and
 * toggle label/icon from one place.
 */
const METRIC_PRESENTATION: Record<
  UsageMetric,
  {
    label: string;
    Icon: typeof LayersIcon;
    formatValue: (value: number) => string;
    allowDecimals: boolean;
  }
> = {
  [UsageMetric.Cost]: {
    // ISS-4994 (review thread): "Cost", not "Spend". This toggle is the control
    // the reader actually clicks to reach the cost view, and it sits directly
    // under a card now titled "Model cost over time" described as an ESTIMATED,
    // subscription-inclusive figure. Leaving it "Spend" put the one word this
    // change removes closer to the eye than the title that replaced it.
    label: "Cost",
    Icon: DollarSignIcon,
    formatValue: metricValueFormatter("cost"),
    allowDecimals: metricAllowsFractions("cost"),
  },
  [UsageMetric.Tokens]: {
    label: "Tokens",
    Icon: HashIcon,
    formatValue: metricValueFormatter("tokens"),
    allowDecimals: metricAllowsFractions("tokens"),
  },
};

// Ordered metric list for rendering the toggle group (Spend, then Tokens).
const METRICS: UsageMetric[] = [UsageMetric.Cost, UsageMetric.Tokens];

/** Resolve the shared presentation (label, icon, formatter) for a metric. */
export function usageMetricPresentation(metric: UsageMetric) {
  return METRIC_PRESENTATION[metric];
}

/**
 * Re-aggregate a per-model time series into a per-provider one, client-side, by
 * folding each model's per-bucket values into its inferred provider. Series keys
 * become provider names; values sum. Shared so the dashboard and the Agents
 * detail chart attribute providers identically.
 */
export function groupByProvider(series: TimeSeries): TimeSeries {
  const providers: string[] = [];
  for (const s of series.series) {
    const provider = providerOf(s.key);
    if (!providers.includes(provider)) {
      providers.push(provider);
    }
  }
  return {
    series: providers.map((provider) => ({ key: provider, label: provider })),
    points: series.points.map((point) => {
      const values: Record<string, number> = {};
      for (const [modelKey, value] of Object.entries(point.values)) {
        const provider = providerOf(modelKey);
        values[provider] = (values[provider] ?? 0) + (value ?? 0);
      }
      return { date: point.date, values };
    }),
  };
}

/**
 * The two-toggle controls row shared by the dashboard's usage graph and the
 * Agents component-detail token-trend chart: a $/# metric toggle on the left, a
 * model/provider grouping toggle on the right — "across from" each other. Both
 * groups are keyboard-navigable and carry accessible names/labels (the shared
 * `ToggleGroup` primitive is a Radix roving-tabindex toolbar).
 */
export function UsageGraphControls({
  metric,
  onMetricChange,
  grouping,
  onGroupingChange,
}: {
  metric: UsageMetric;
  onMetricChange: (metric: UsageMetric) => void;
  grouping: UsageGrouping;
  onGroupingChange: (grouping: UsageGrouping) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
      <ToggleGroup
        aria-label="Metric"
        onValueChange={(next) => {
          if (next) {
            onMetricChange(next as UsageMetric);
          }
        }}
        type="single"
        value={metric}
        variant="outline"
      >
        {METRICS.map((key) => {
          const { label, Icon } = METRIC_PRESENTATION[key];
          return (
            <ToggleGroupItem aria-label={label} key={key} value={key}>
              <Icon className="size-3.5" />
              {label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <ToggleGroup
        aria-label="Grouping"
        onValueChange={(next) => {
          if (next) {
            onGroupingChange(next as UsageGrouping);
          }
        }}
        type="single"
        value={grouping}
        variant="outline"
      >
        {GROUPINGS.map(({ key, label, Icon }) => (
          <ToggleGroupItem aria-label={label} key={key} value={key}>
            <Icon className="size-3.5" />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * ISS-5523 — the noun the charts' aggregate band is named with, for the grouping
 * currently on screen. Shared by every chart carrying these toggles so the band
 * cannot read one way on one graph and another on its neighbour while both are
 * grouped the same way.
 *
 * The chart appends the count itself, so this returns the bare noun and the band
 * renders as e.g. "Other models (7)" — never a bare "Other", which would leave a
 * reader unable to tell an aggregate from a real series.
 *
 * The provider axis says "providers" and NOT "Other providers" on purpose:
 * `providerOf` already emits a real bucket literally named "Other" for models it
 * cannot attribute, so an aggregate called "Other providers (N)" would sit in the
 * same legend as a genuine series called "Other" and invite the reader to treat
 * one as the other. "Remaining providers (N)" keeps the two distinguishable.
 * (Provider grouping yields only a handful of buckets today, so this branch is
 * not reachable at the current cap — it is written correctly so that it stays
 * correct if the provider set grows.)
 */
export function usageOtherSeriesLabel(grouping: UsageGrouping): string {
  return grouping === UsageGrouping.Provider
    ? "Remaining providers"
    : "Other models";
}
