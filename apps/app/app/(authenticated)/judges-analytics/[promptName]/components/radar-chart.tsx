"use client";

import type {
  JudgePromptVersion,
  RadarAxes,
} from "@repo/api/src/types/judges-analytics";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Label } from "@repo/design-system/components/ui/label";
import { useState } from "react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart as RechartsRadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  JUDGES_ANALYTICS_CHART_COLOR_TOKEN_COUNT,
  JUDGES_ANALYTICS_LATEST_RADAR_COLOR,
} from "@/lib/config/judges-analytics";
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

function buildAxesData(axes: RadarAxes | null) {
  if (!axes) {
    return AXIS_LABELS_ORDERED.map((axis) => ({ axis, latest: 0 }));
  }
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
      <TooltipRow label="Latest" value={datum.latest.toFixed(2)} />
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
            value={value.toFixed(2)}
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
  const insufficientData = radarAxes === null;
  const selectedVersions = selectedVersionIds
    .map((versionId) =>
      promptVersions.find((version) => version.promptId === versionId)
    )
    .filter((version): version is JudgePromptVersion => version !== undefined);

  const baseData = buildAxesData(insufficientData ? null : radarAxes);

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
      <div className="relative">
        <ResponsiveContainer height={300} width="100%">
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
        </ResponsiveContainer>
        {insufficientData && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <p className="font-medium text-muted-foreground text-sm">
              Insufficient data
            </p>
          </div>
        )}
      </div>

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
