"use client";

import type { JudgeAggregateStats } from "@repo/api/src/types/judges-analytics";
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
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useMemo } from "react";
import { useSortParams } from "@/hooks/use-sort-params";
import judgeDescriptions from "@/lib/judge-descriptions.json";
import type { SortConfig } from "@/lib/table-utils";
import { sortTableData } from "@/lib/table-utils";

type JudgeAnalyticsTableProps = {
  data: JudgeAggregateStats[];
};

function formatOrDash(value: number | null): string {
  return value !== null ? value.toFixed(2) : "\u2014";
}

const JUDGE_SORT_COLUMNS = [
  "judgeName",
  "artifactsEvaluated",
  "min",
  "mean",
  "max",
  "stdDev",
] as const;

type JudgeSortColumn = (typeof JUDGE_SORT_COLUMNS)[number];

const JUDGE_SORT_CONFIGS: Record<
  JudgeSortColumn,
  SortConfig<JudgeAggregateStats>
> = {
  judgeName: { key: "judgeName", columnType: "string" },
  artifactsEvaluated: { key: "artifactsEvaluated", columnType: "number" },
  min: { key: "min", columnType: "number" },
  mean: { key: "mean", columnType: "number" },
  max: { key: "max", columnType: "number" },
  stdDev: { key: "stdDev", columnType: "number" },
};

export function JudgeAnalyticsTable({ data }: JudgeAnalyticsTableProps) {
  const { sortBy, sortDir } = useSortParams<JudgeSortColumn>({
    defaultColumn: null,
    defaultDirection: "desc",
    validColumns: JUDGE_SORT_COLUMNS,
  });

  const sortedData = useMemo(
    () => sortTableData(data, sortBy, JUDGE_SORT_CONFIGS, sortDir),
    [data, sortBy, sortDir]
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="align-bottom" rowSpan={2}>
            Judge Name
          </TableHead>
          <TableHead className="align-bottom" rowSpan={2}>
            Artifacts Evaluated
          </TableHead>
          <TableHead className="border-b-0 text-center" colSpan={4}>
            Eval
          </TableHead>
          <TableHead className="border-b-0 text-center" colSpan={4}>
            Human
          </TableHead>
        </TableRow>
        <TableRow>
          <TableHead>Min</TableHead>
          <TableHead>Max</TableHead>
          <TableHead>Mean</TableHead>
          <TableHead>Std Dev</TableHead>
          <TableHead>Min</TableHead>
          <TableHead>Max</TableHead>
          <TableHead>Mean</TableHead>
          <TableHead>Std Dev</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedData.map((judge: JudgeAggregateStats) => (
          <TableRow key={judge.judgeName}>
            <TableCell className="break-words">
              {judgeDescriptions[
                judge.judgeName as keyof typeof judgeDescriptions
              ] ? (
                <Tooltip>
                  <TooltipTrigger className="cursor-help underline decoration-dotted">
                    {judge.judgeName}
                  </TooltipTrigger>
                  <TooltipContent>
                    {
                      judgeDescriptions[
                        judge.judgeName as keyof typeof judgeDescriptions
                      ]
                    }
                  </TooltipContent>
                </Tooltip>
              ) : (
                judge.judgeName
              )}
            </TableCell>
            <TableCell>{judge.artifactsEvaluated}</TableCell>
            <TableCell>{judge.min.toFixed(2)}</TableCell>
            <TableCell>{judge.max.toFixed(2)}</TableCell>
            <TableCell>{judge.mean.toFixed(2)}</TableCell>
            <TableCell>{judge.stdDev.toFixed(2)}</TableCell>
            <TableCell>{formatOrDash(judge.humanMin)}</TableCell>
            <TableCell>{formatOrDash(judge.humanMax)}</TableCell>
            <TableCell>{formatOrDash(judge.humanMean)}</TableCell>
            <TableCell>{formatOrDash(judge.humanStdDev)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
