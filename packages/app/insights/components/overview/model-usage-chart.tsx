"use client";

import type { TimeSeries } from "@repo/api/src/types/insights";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { BoxIcon, LayersIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { metricAllowsFractions, metricValueFormatter } from "../../lib/format";
import { SectionHeader } from "./section-header";

type Grouping = "model" | "provider";

// USD spend formatter (FEA-2331): the model series is estimated cost, not tokens.
const formatSpend = metricValueFormatter("cost");
// Spend is sub-dollar-capable, so the y-axis needs fractional ticks.
const SPEND_ALLOWS_DECIMALS = metricAllowsFractions("cost");

const GROUPINGS: { key: Grouping; label: string; Icon: typeof LayersIcon }[] = [
  { key: "model", label: "By model", Icon: LayersIcon },
  { key: "provider", label: "By provider", Icon: BoxIcon },
];

// Best-effort provider attribution from the model identifier.
function providerOf(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("claude")) {
    return "Anthropic";
  }
  if (
    m.includes("gpt") ||
    m.includes("codex") ||
    m.startsWith("o1") ||
    m.startsWith("o3")
  ) {
    return "OpenAI";
  }
  if (m.includes("gemini")) {
    return "Google";
  }
  return "Other";
}

function groupByProvider(series: TimeSeries): TimeSeries {
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
        values[provider] = (values[provider] ?? 0) + value;
      }
      return { date: point.date, values };
    }),
  };
}

/**
 * "Model Spend Over Time" — the shared stacked time-series chart fed by the
 * Agents insights (`modelUsageOverTime`, now estimated USD spend), with a By
 * model / By provider toggle that re-aggregates the model series into providers
 * client-side. FEA-2331: spend is cache-neutral, so it reflects where the money
 * actually goes (raw token counts understate cache-heavy harnesses).
 */
export function ModelUsageChart({
  series,
}: {
  series: TimeSeries | undefined;
}) {
  const [grouping, setGrouping] = useState<Grouping>("model");
  const chart = useMemo(() => {
    if (!series) {
      return undefined;
    }
    return grouping === "provider" ? groupByProvider(series) : series;
  }, [series, grouping]);

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        actions={
          <ToggleGroup
            aria-label="Grouping"
            onValueChange={(next) => {
              if (next) {
                setGrouping(next as Grouping);
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
        }
        description="Daily estimated spend by model"
        title="Model Spend Over Time"
      />
      <div className="min-h-0 flex-1">
        {chart ? (
          <TimeSeriesAreaChart
            allowDecimals={SPEND_ALLOWS_DECIMALS}
            emptyMessage="No model spend in range yet"
            points={chart.points}
            series={chart.series}
            valueFormatter={formatSpend}
          />
        ) : (
          <Skeleton className="h-full w-full" />
        )}
      </div>
    </div>
  );
}
