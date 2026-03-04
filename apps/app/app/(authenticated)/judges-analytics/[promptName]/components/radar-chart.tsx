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

type JudgeRadarChartProps = {
  radarAxes: RadarAxes | null;
  promptVersions: JudgePromptVersion[];
};

const AXIS_LABELS = ["Stubbornness", "Optimism", "Polarity", "Certainty"];

const CHART_COLOR_TOKEN_COUNT = 5;
const LATEST_COLOR = "var(--chart-1)";

type RadarChartDatum = {
  axis: string;
  latest: number;
} & Record<string, number | string | undefined>;

type RadarTooltipPayloadItem = {
  payload?: RadarChartDatum;
};

function getOverlayColor(index: number): string {
  // Start from chart-2 to keep "Latest" visually distinct from overlays by default.
  const tokenIndex = ((index + 1) % CHART_COLOR_TOKEN_COUNT) + 1;
  return `var(--chart-${tokenIndex})`;
}

function buildAxesData(axes: RadarAxes | null) {
  if (!axes) {
    return AXIS_LABELS.map((axis) => ({ axis, latest: 0 }));
  }
  return [
    { axis: "Stubbornness", latest: axes.stubbornness },
    { axis: "Optimism", latest: axes.optimism },
    { axis: "Polarity", latest: axes.polarity },
    { axis: "Certainty", latest: axes.certainty },
  ];
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
    <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
      <p className="mb-2 font-medium">{datum.axis}</p>
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Latest</span>
          <span className="font-medium font-mono">
            {datum.latest.toFixed(2)}
          </span>
        </div>
        {selectedVersions.map((version) => {
          const dataKey = `v${version.version}`;
          const value = datum[dataKey];
          if (typeof value !== "number") {
            return null;
          }

          return (
            <div
              className="flex items-center justify-between gap-4"
              key={dataKey}
            >
              <span className="text-muted-foreground">v{version.version}</span>
              <span className="font-medium font-mono">{value.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
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
    for (const versionId of selectedVersionIds) {
      const version = promptVersions.find((v) => v.promptId === versionId);
      if (version) {
        const axes = getVersionAxes(version);
        if (axes) {
          const key = point.axis.toLowerCase() as keyof typeof axes;
          entry[`v${version.version}`] = axes[key] ?? 0;
        }
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
              fill={LATEST_COLOR}
              fillOpacity={0.2}
              name="Latest"
              stroke={LATEST_COLOR}
              strokeWidth={2}
            />
            {selectedVersionIds.map((versionId, index) => {
              const version = promptVersions.find(
                (v) => v.promptId === versionId
              );
              if (!version) {
                return null;
              }
              const color = getOverlayColor(index);
              return (
                <Radar
                  dataKey={`v${version.version}`}
                  fill={color}
                  fillOpacity={0.1}
                  key={versionId}
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
