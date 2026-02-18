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
import { useMemo } from "react";
import { SortableColumnHeader } from "@/components/sortable-column-header";
import { useSortParams } from "@/hooks/use-sort-params";
import type { SortConfig } from "@/lib/table-utils";
import { sortTableData } from "@/lib/table-utils";

type JudgeAnalyticsTableProps = {
  data: JudgeAggregateStats[];
  humanRatingsCount?: number;
  humanCommentsCount?: number;
};

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

export function JudgeAnalyticsTable({
  data,
  humanRatingsCount = 0,
  humanCommentsCount = 0,
}: JudgeAnalyticsTableProps) {
  const { sortBy, sortDir, setSort } = useSortParams<JudgeSortColumn>({
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
          <SortableColumnHeader
            column="judgeName"
            label="Judge Name"
            onSort={setSort}
            sortBy={sortBy}
            sortDir={sortDir}
          />
          <SortableColumnHeader
            column="artifactsEvaluated"
            label="Artifacts Evaluated"
            onSort={setSort}
            sortBy={sortBy}
            sortDir={sortDir}
          />
          <SortableColumnHeader
            column="min"
            label="Min"
            onSort={setSort}
            sortBy={sortBy}
            sortDir={sortDir}
          />
          <SortableColumnHeader
            column="mean"
            label="Mean"
            onSort={setSort}
            sortBy={sortBy}
            sortDir={sortDir}
          />
          <SortableColumnHeader
            column="max"
            label="Max"
            onSort={setSort}
            sortBy={sortBy}
            sortDir={sortDir}
          />
          <SortableColumnHeader
            column="stdDev"
            label="Std Dev"
            onSort={setSort}
            sortBy={sortBy}
            sortDir={sortDir}
          />
          <TableHead>Human Ratings</TableHead>
          <TableHead>Human Comments</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedData.map((judge: JudgeAggregateStats) => (
          <TableRow key={judge.judgeName}>
            <TableCell className="break-words" title={judge.judgeName}>
              {judge.judgeName}
            </TableCell>
            <TableCell>{judge.artifactsEvaluated}</TableCell>
            <TableCell>{judge.min.toFixed(2)}</TableCell>
            <TableCell>{judge.mean.toFixed(2)}</TableCell>
            <TableCell>{judge.max.toFixed(2)}</TableCell>
            <TableCell>{judge.stdDev.toFixed(2)}</TableCell>
            <TableCell className="text-muted-foreground">&mdash;</TableCell>
            <TableCell className="text-muted-foreground">&mdash;</TableCell>
          </TableRow>
        ))}
        <TableRow>
          <TableCell className="font-medium">Human</TableCell>
          <TableCell className="text-muted-foreground">&mdash;</TableCell>
          <TableCell className="text-muted-foreground">&mdash;</TableCell>
          <TableCell className="text-muted-foreground">&mdash;</TableCell>
          <TableCell className="text-muted-foreground">&mdash;</TableCell>
          <TableCell className="text-muted-foreground">&mdash;</TableCell>
          <TableCell>{humanRatingsCount}</TableCell>
          <TableCell>{humanCommentsCount}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
