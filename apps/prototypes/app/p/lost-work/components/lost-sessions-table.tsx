"use client";

import { Section } from "@repo/design-system/components/ui/layout/section";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  SortableColumnHeader,
  type SortDirection,
} from "@repo/design-system/components/ui/sortable-column-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import { useState } from "react";
import {
  DataState,
  formatBucketDate,
  formatCount,
  formatHours,
} from "@/lib/analytics/format";
import {
  LOSS_CLASS_LABELS,
  LossClass,
  minutesToHours,
} from "@/lib/analytics/session-fixture";
import { type LostSessionRow, lostSessionRows } from "../mock";

/**
 * The sessions that consumed wall-clock and produced nothing, so a manager can
 * go from a number in the table above to the actual runs behind it.
 *
 * The class column uses `ToneLabel`, a plain colored string, rather than a
 * badge: the value is present on every row, so boxing it would be chrome on
 * every line for no added signal.
 */

const SortColumn = {
  Date: "date",
  Minutes: "minutes",
} as const;
type SortColumn = (typeof SortColumn)[keyof typeof SortColumn];

const VISIBLE_ROW_LIMIT = 12;
const SKELETON_ROW_COUNT = 6;
const SESSION_COLUMN_COUNT = 6;
const NUMERIC_CELL_CLASS = "text-right tabular-nums";

/**
 * Class -> `Badge`/`ToneLabel` variant. Kept as an exhaustive record so a new
 * loss class fails typecheck here instead of rendering unstyled.
 */
const LOSS_CLASS_VARIANT: Record<LossClass, "error" | "info" | "muted"> = {
  [LossClass.Actionable]: "error",
  [LossClass.Systemic]: "info",
  [LossClass.Unattributed]: "muted",
};

export function LostSessionsTable({
  dataState,
}: {
  readonly dataState: DataState;
}) {
  const [sortBy, setSortBy] = useState<SortColumn>(SortColumn.Minutes);
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

  const handleSort = (column: SortColumn, direction: SortDirection) => {
    setSortBy(column);
    setSortDir(direction);
  };

  const rows = sortRows(lostSessionRows, sortBy, sortDir).slice(
    0,
    VISIBLE_ROW_LIMIT
  );

  return (
    <Section
      description={`${formatCount(lostSessionRows.length)} sessions in range yielded no artifact. Showing the ${VISIBLE_ROW_LIMIT} costliest.`}
      title="Sessions with no artifact"
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Session</TableHead>
            <TableHead>Engineer</TableHead>
            <TableHead>Repo and project</TableHead>
            <SortableColumnHeader
              className={NUMERIC_CELL_CLASS}
              column={SortColumn.Minutes}
              label="Wall-clock lost"
              onSort={handleSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <TableHead>Cause</TableHead>
            <SortableColumnHeader
              column={SortColumn.Date}
              label="Last activity"
              onSort={handleSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {dataState === DataState.Loading
            ? renderSkeletonRows()
            : rows.map((row) => <SessionRow key={row.id} row={row} />)}
        </TableBody>
      </Table>
    </Section>
  );
}

function SessionRow({ row }: { readonly row: LostSessionRow }) {
  return (
    <TableRow>
      <TableCell className="max-w-xs">
        <div className="truncate font-medium text-sm">{row.title}</div>
        <div className="text-muted-foreground text-xs">{row.id}</div>
      </TableCell>
      <TableCell className="text-sm">{row.engineer}</TableCell>
      <TableCell>
        <div className="text-sm">{row.repo}</div>
        <div className="text-muted-foreground text-xs">{row.project}</div>
      </TableCell>
      <TableCell className={NUMERIC_CELL_CLASS}>
        {formatHours(minutesToHours(row.minutes))}
      </TableCell>
      <TableCell>
        <div className="text-sm">{row.cause}</div>
        <ToneLabel variant={LOSS_CLASS_VARIANT[row.lossClass]}>
          {LOSS_CLASS_LABELS[row.lossClass]}
        </ToneLabel>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {formatBucketDate(row.date)}
      </TableCell>
    </TableRow>
  );
}

function renderSkeletonRows() {
  return Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder rows with no identity of their own
    <TableRow key={index}>
      {Array.from({ length: SESSION_COLUMN_COUNT }, (__, cell) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder cells
        <TableCell key={cell}>
          <Skeleton className="h-5 w-full rounded" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

/** Sorts on the real field, never the rendered string. */
function sortRows(
  rows: readonly LostSessionRow[],
  sortBy: SortColumn,
  sortDir: SortDirection
): LostSessionRow[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sortBy === SortColumn.Date) {
      return a.date.localeCompare(b.date) * direction;
    }
    return (a.minutes - b.minutes) * direction;
  });
}
