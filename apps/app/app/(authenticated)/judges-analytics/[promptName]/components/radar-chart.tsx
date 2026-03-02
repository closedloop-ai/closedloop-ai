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
  Radar,
  RadarChart as RechartsRadarChart,
  ResponsiveContainer,
} from "recharts";

type JudgeRadarChartProps = {
  radarAxes: RadarAxes | null;
  promptVersions: JudgePromptVersion[];
};

const AXIS_LABELS = ["Stubbornness", "Optimism", "Polarity", "Certainty"];

const VERSION_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6"];

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

export function JudgeRadarChart({
  radarAxes,
  promptVersions,
}: JudgeRadarChartProps) {
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);
  const insufficientData = radarAxes === null;

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
            <Radar
              dataKey="latest"
              fill="#3b82f6"
              fillOpacity={0.2}
              name="Latest"
              stroke="#3b82f6"
              strokeWidth={2}
            />
            {selectedVersionIds.map((versionId, index) => {
              const version = promptVersions.find(
                (v) => v.promptId === versionId
              );
              if (!version) {
                return null;
              }
              const color = VERSION_COLORS[(index + 1) % VERSION_COLORS.length];
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
