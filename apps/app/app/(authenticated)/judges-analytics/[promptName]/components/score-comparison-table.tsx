"use client";

import { getRoutePrefixForType } from "@repo/api/src/types/artifact";
import type { JudgeScoreRow } from "@repo/api/src/types/judges-analytics";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { InfoIcon } from "lucide-react";
import Link from "next/link";
import {
  JUDGES_ANALYTICS_DELTA_CRITICAL_THRESHOLD,
  JUDGES_ANALYTICS_DELTA_WARNING_THRESHOLD,
  JUDGES_ANALYTICS_SCORE_TABLE_MAX_HEIGHT_CLASS,
} from "@/lib/config/judges-analytics";

type ScoreComparisonTableProps = {
  rows: JudgeScoreRow[];
};

function getDeltaClassName(delta: number): string {
  if (delta > JUDGES_ANALYTICS_DELTA_CRITICAL_THRESHOLD) {
    return "text-red-600 dark:text-red-400 font-medium";
  }
  if (delta > JUDGES_ANALYTICS_DELTA_WARNING_THRESHOLD) {
    return "text-amber-600 dark:text-amber-400 font-medium";
  }
  return "";
}

function formatAvgUserRating(row: JudgeScoreRow): string {
  if (row.userRatingCount > 0) {
    return `${row.avgUserRating.toFixed(2)} (${row.userRatingCount})`;
  }
  return row.avgUserRating.toFixed(2);
}

function getArtifactHref(row: JudgeScoreRow): string {
  const routePrefix = getRoutePrefixForType(row.artifactType);
  if (routePrefix === null) {
    return `/artifacts/${row.artifactSlug}`;
  }
  return `/${routePrefix}/${row.artifactSlug}`;
}

export function ScoreComparisonTable({ rows }: ScoreComparisonTableProps) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No score data available.</p>
    );
  }

  return (
    <div
      className={cn(
        JUDGES_ANALYTICS_SCORE_TABLE_MAX_HEIGHT_CLASS,
        "overflow-y-auto rounded-md border"
      )}
      data-testid="score-comparison-scroll-container"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Artifact</TableHead>
            <TableHead className="text-right">Judge Score</TableHead>
            <TableHead className="text-right">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-help items-center gap-1">
                      Avg. User Rating
                      <InfoIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-left">
                    When org members have rated this artifact for this judge,
                    shows the average of those ratings. When no ratings exist,
                    assumes concurrence with the LLM judge and displays the
                    judge score.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </TableHead>
            <TableHead className="text-right">Delta</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.judgeScoreId}>
              <TableCell>
                <Link
                  className="text-primary hover:underline"
                  href={getArtifactHref(row)}
                >
                  {row.artifactTitle}
                </Link>
              </TableCell>
              <TableCell className="text-right">
                {row.judgeScore.toFixed(2)}
              </TableCell>
              <TableCell className="text-right">
                {formatAvgUserRating(row)}
              </TableCell>
              <TableCell
                className={cn("text-right", getDeltaClassName(row.delta))}
              >
                {row.delta === 0 ? "—" : row.delta.toFixed(2)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
