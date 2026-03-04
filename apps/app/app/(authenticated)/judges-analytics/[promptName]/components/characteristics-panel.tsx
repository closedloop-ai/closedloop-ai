"use client";

import type { JudgeDetail } from "@repo/api/src/types/judges-analytics";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { AlertCircleIcon } from "lucide-react";
import { JudgeRadarChart } from "./radar-chart";

type CharacteristicsPanelProps = {
  judge: JudgeDetail;
};

export function CharacteristicsPanel({ judge }: CharacteristicsPanelProps) {
  const insufficientData = judge.radarAxes === null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Characteristics</CardTitle>
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
