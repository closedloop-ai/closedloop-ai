"use client";

import type { JudgeDetail } from "@repo/api/src/types/judges-analytics";
import { formatScorePercent } from "@repo/app/documents/lib/evaluation-utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";

type PromptSectionProps = {
  judge: JudgeDetail;
};

export function PromptSection({ judge }: PromptSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Prompt</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {judge.promptText ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-sm">
            {judge.promptText}
          </pre>
        ) : (
          <p className="text-muted-foreground text-sm">Prompt not available</p>
        )}

        <div>
          <h3 className="mb-2 font-medium text-sm">Version Statistics</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Score Count</TableHead>
                <TableHead>Mean</TableHead>
                <TableHead>Std Dev</TableHead>
                <TableHead>Min</TableHead>
                <TableHead>Max</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {judge.promptVersions.map((version) => (
                <TableRow key={version.promptId}>
                  <TableCell>v{version.version}</TableCell>
                  <TableCell>{version.scoreCount}</TableCell>
                  <TableCell>{formatScorePercent(version.mean)}</TableCell>
                  <TableCell>{formatScorePercent(version.stdDev)}</TableCell>
                  <TableCell>{formatScorePercent(version.min)}</TableCell>
                  <TableCell>{formatScorePercent(version.max)}</TableCell>
                </TableRow>
              ))}
              {judge.unknownVersionScoreCount > 0 && (
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    Unknown
                  </TableCell>
                  <TableCell>{judge.unknownVersionScoreCount}</TableCell>
                  <TableCell className="text-muted-foreground" colSpan={4}>
                    &mdash;
                  </TableCell>
                </TableRow>
              )}
              {judge.promptVersions.length === 0 &&
                judge.unknownVersionScoreCount === 0 && (
                  <TableRow>
                    <TableCell
                      className="text-center text-muted-foreground"
                      colSpan={6}
                    >
                      No version data available
                    </TableCell>
                  </TableRow>
                )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
