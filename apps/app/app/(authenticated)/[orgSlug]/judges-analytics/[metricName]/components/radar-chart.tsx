"use client";

import type {
  JudgePromptVersion,
  RadarAxes,
} from "@repo/api/src/types/judges-analytics";
import { formatScorePercent } from "@repo/app/documents/lib/evaluation-utils";
import {
  JUDGES_ANALYTICS_CHART_COLOR_TOKEN_COUNT,
  JUDGES_ANALYTICS_LATEST_RADAR_COLOR,
} from "@repo/app/judges-analytics/lib/judges-analytics";
import {
  type ChartConfig,
  ChartContainer,
} from "@repo/design-system/components/ui/chart";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Label } from "@repo/design-system/components/ui/label";
import { useState } from "react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart as RechartsRadarChart,
  Tooltip,
} from "recharts";
import { TooltipRow, TooltipShell } from "../../components/chart-tooltip";

type JudgeRadarChartProps = {
  radarAxes: RadarAxes | null;
  promptVersions: JudgePromptVersion[];
};

export const AxisLabels = {
  Stubbornness: "Stubbornness",
  Optimism: "Optimism",
  Polarity: "Polarity",
  Certainty: "Certainty",
} as const;

export type AxisLabel = (typeof AxisLabels)[keyof typeof AxisLabels];

function getOverlayColor(index: number): string {
  // Start from chart-2 to keep "Latest" visually distinct from overlays by default.
  const tokenIndex =
    ((index + 1) % JUDGES_ANALYTICS_CHART_COLOR_TOKEN_COUNT) + 1;
  return `var(--chart-${tokenIndex})`;
}

const AXIS_LABELS_ORDERED = Object.values(AxisLabels);

// FEA-4149 (FEA-3961 pattern): host Recharts through the shared design-system
// `ChartContainer` (not a raw `ResponsiveContainer`). ChartContainer floors the
// laid-out box with `min-h-40` and matches that on its inner ResponsiveContainer,
// so a parent that momentarily resolves to 0 (a tab/panel reveal, a
// `display:none → visible` transition, or a grid cell before its track settles)
// still measures real pixels and never logs `width(-1) and height(-1) ... should
// be greater than 0` or renders an invisible chart. It also carries the
// `.recharts-polar-grid [stroke='#ccc'] → stroke-border` token so the grid uses
// the border token instead of Recharts' hardcoded light grey. `h-64` matches the
// sibling judge chart's height scale.
const RADAR_CHART_CONFIG: ChartConfig = {
  latest: { label: "Latest", color: JUDGES_ANALYTICS_LATEST_RADAR_COLOR },
};

function buildAxesData(axes: RadarAxes) {
  return AXIS_LABELS_ORDERED.map((axis) => ({
    axis,
    latest: axes[AXIS_KEY_BY_LABEL[axis]],
  }));
}

function getVersionAxes(version: JudgePromptVersion): RadarAxes | null {
  return version.radarAxes;
}

function RadarAxisTooltip({
  active,
  payload,
  selectedVersions,
}: {
  active?: boolean;
  payload?: RadarTooltipPayloadItem[];
  selectedVersions: JudgePromptVersion[];
}) {
  if (!(active && payload) || payload.length === 0) {
    return null;
  }

  const datum = payload[0]?.payload;
  if (!datum) {
    return null;
  }

  return (
    <TooltipShell title={datum.axis}>
      <TooltipRow label="Latest" value={formatScorePercent(datum.latest)} />
      {selectedVersions.map((version) => {
        const dataKey = `v${version.version}`;
        const value = datum[dataKey];
        if (typeof value !== "number") {
          return null;
        }

        return (
          <TooltipRow
            key={dataKey}
            label={`v${version.version}`}
            value={formatScorePercent(value)}
          />
        );
      })}
    </TooltipShell>
  );
}

export function JudgeRadarChart({
  radarAxes,
  promptVersions,
}: JudgeRadarChartProps) {
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);
  const selectedVersions = selectedVersionIds
    .map((versionId) =>
      promptVersions.find((version) => version.promptId === versionId)
    )
    .filter((version): version is JudgePromptVersion => version !== undefined);

  // When there are no scores yet, the parent CharacteristicsPanel already
  // renders the single "Insufficient data" Alert. Rendering an all-zero radar
  // under a duplicate scrim here would both say it twice and read as "every
  // score is zero" rather than "no data yet", so render nothing at all.
  if (radarAxes === null) {
    return null;
  }

  const baseData = buildAxesData(radarAxes);

  // Merge selected version data into chart data
  const chartData = baseData.map((point) => {
    const entry: Record<string, string | number> = {
      axis: point.axis,
      latest: point.latest,
    };
    for (const version of selectedVersions) {
      const axes = getVersionAxes(version);
      if (axes) {
        entry[`v${version.version}`] = axes[AXIS_KEY_BY_LABEL[point.axis]] ?? 0;
      }
    }
    return entry;
  });

  const handleVersionToggle = (promptId: string, checked: boolean) => {
    if (checked) {
      setSelectedVersionIds((prev) => [...prev, promptId]);
    } else {
      setSelectedVersionIds((prev) => prev.filter((id) => id !== promptId));
    }
  };

  return (
    <div className="space-y-4">
      <ChartContainer
        className="aspect-auto h-64 w-full"
        config={RADAR_CHART_CONFIG}
      >
        <RechartsRadarChart data={chartData}>
          <PolarGrid />
          <PolarAngleAxis dataKey="axis" />
          <PolarRadiusAxis domain={[0, 1]} tick={false} />
          <Tooltip
            content={<RadarAxisTooltip selectedVersions={selectedVersions} />}
            cursor={false}
          />
          <Radar
            dataKey="latest"
            fill={JUDGES_ANALYTICS_LATEST_RADAR_COLOR}
            fillOpacity={0.2}
            name="Latest"
            stroke={JUDGES_ANALYTICS_LATEST_RADAR_COLOR}
            strokeWidth={2}
          />
          {selectedVersions.map((version, index) => {
            const color = getOverlayColor(index);
            return (
              <Radar
                dataKey={`v${version.version}`}
                fill={color}
                fillOpacity={0.1}
                key={version.promptId}
                name={`v${version.version}`}
                stroke={color}
                strokeDasharray="4 4"
                strokeWidth={2}
              />
            );
          })}
        </RechartsRadarChart>
      </ChartContainer>

      {promptVersions.length > 0 && (
        <div className="space-y-2">
          <p className="font-medium text-sm">Compare versions</p>
          <div className="flex flex-wrap gap-3">
            {promptVersions.map((version) => (
              <div className="flex items-center gap-1.5" key={version.promptId}>
                <Checkbox
                  checked={selectedVersionIds.includes(version.promptId)}
                  id={`version-${version.promptId}`}
                  onCheckedChange={(checked) =>
                    handleVersionToggle(version.promptId, checked === true)
                  }
                />
                <Label
                  className="text-sm"
                  htmlFor={`version-${version.promptId}`}
                >
                  v{version.version} ({version.scoreCount} scores)
                </Label>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type RadarChartDatum = {
  axis: AxisLabel;
  latest: number;
} & Record<string, number | string | undefined>;

type RadarTooltipPayloadItem = {
  payload?: RadarChartDatum;
};

const AXIS_KEY_BY_LABEL: Record<AxisLabel, keyof RadarAxes> = {
  Stubbornness: "stubbornness",
  Optimism: "optimism",
  Polarity: "polarity",
  Certainty: "certainty",
};
