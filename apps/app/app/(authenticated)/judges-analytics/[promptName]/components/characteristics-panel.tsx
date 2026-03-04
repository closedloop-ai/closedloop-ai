"use client";

import { JUDGE_RADAR_METRICS } from "@repo/api/src/constants";
import type { JudgeDetail } from "@repo/api/src/types/judges-analytics";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { AlertCircleIcon, InfoIcon } from "lucide-react";
import { AXIS_LABELS, type AxisLabel, JudgeRadarChart } from "./radar-chart";

type CharacteristicsPanelProps = {
  judge: JudgeDetail;
};

export function CharacteristicsPanel({ judge }: CharacteristicsPanelProps) {
  const insufficientData = judge.radarAxes === null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Characteristics</CardTitle>
          <MetricsHelpButton />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {insufficientData && (
          <Alert>
            <AlertCircleIcon className="h-4 w-4" />
            <AlertTitle>Insufficient data</AlertTitle>
            <AlertDescription>
              Not enough scores recorded to compute radar axes and
              characteristics.
            </AlertDescription>
          </Alert>
        )}

        {!insufficientData && judge.labels.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No strong tendencies detected.
          </p>
        )}

        {!insufficientData && judge.labels.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {judge.labels.map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))}
          </div>
        )}

        <JudgeRadarChart
          promptVersions={judge.promptVersions}
          radarAxes={judge.radarAxes}
        />
      </CardContent>
    </Card>
  );
}

function MetricsHelpButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Explain judge chart metrics"
          className="h-6 w-6 rounded-full"
          size="icon"
          type="button"
          variant="ghost"
        >
          <InfoIcon className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] space-y-3 p-4">
        <p className="font-medium text-sm">How to interpret the chart axes</p>
        <div className="space-y-2 text-xs">
          {AXIS_HELP_ITEMS.map((item) => (
            <div className="space-y-1" key={item.axis}>
              <p className="font-medium">{item.axis}</p>
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Math:</span>{" "}
                {item.formula}
              </p>
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Business:</span>{" "}
                {item.interpretation}
              </p>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const AXIS_HELP_BY_LABEL: Record<
  AxisLabel,
  { formula: string; interpretation: string }
> = {
  Stubbornness: {
    formula: `1 - clamp(stdDev / ${JUDGE_RADAR_METRICS.stubbornness.stdDevNormalizationDivisor}, 0, 1)`,
    interpretation:
      "Higher means the judge scores more consistently across artifacts.",
  },
  Optimism: {
    formula: "mean",
    interpretation:
      "Higher means the judge tends to score artifacts more positively.",
  },
  Polarity: {
    formula: "bimodalityCoefficient",
    interpretation:
      "Higher means the judge tends to split between very different score groups.",
  },
  Certainty: {
    formula: `count(score > ${JUDGE_RADAR_METRICS.certainty.extremeHighScore} or score < ${JUDGE_RADAR_METRICS.certainty.extremeLowScore}) / totalScores`,
    interpretation:
      "Higher means the judge more often gives decisive extreme scores rather than middle scores.",
  },
};

const AXIS_HELP_ITEMS = [
  ...AXIS_LABELS.map((axis) => ({
    axis,
    ...AXIS_HELP_BY_LABEL[axis],
  })),
] as const;
