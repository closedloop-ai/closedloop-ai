import type { TimeSeries } from "@repo/api/src/types/insights";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { BoxIcon, LayersIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { SectionHeader } from "./section-header";

type Grouping = "model" | "provider";

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
 * "Model Usage Over Time" — the shared stacked time-series chart fed by the
 * Agents insights (`modelUsageOverTime`), with a By model / By provider toggle
 * that re-aggregates the model series into providers client-side.
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
        description="Daily token usage by model"
        title="Model Usage Over Time"
      />
      <div className="min-h-0 flex-1">
        {chart ? (
          <TimeSeriesAreaChart
            emptyMessage="No model usage in range yet"
            points={chart.points}
            series={chart.series}
          />
        ) : (
          <Skeleton className="h-full w-full" />
        )}
      </div>
    </div>
  );
}
