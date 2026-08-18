"use client";

import {
  LOSS_CLASS_LABELS,
  LossClass,
  type LostWorkSessionRow,
} from "@repo/api/src/types/session-analytics";
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
  formatBucketDate,
  formatCount,
  formatHours,
  minutesToHours,
} from "@/lib/analytics/format";
import { WidgetUnavailable } from "@/lib/analytics/unavailable";

/**
 * The sessions that consumed wall-clock and produced nothing, so a manager can
 * go from a number in the table above to the actual runs behind it.
 *
 * The class column uses `ToneLabel`, a plain colored string, rather than a
 * badge: the value is present on every row, so boxing it would be chrome on
 * every line for no added signal.
 */

export const SESSIONS_UNAVAILABLE_REASON =
  "The lost-session list did not load for this range, so no runs are shown rather than an empty list reading as none.";

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

type LostSessionsTableProps = {
  readonly loading: boolean;
  /** `null` when the lost-session list settled without a value. */
  readonly sessions: readonly LostWorkSessionRow[] | null;
  /**
   * Every lost session in range, from the totals rollup. Kept separate from
   * `sessions.length` so the caption reconciles with the strip at the top of
   * the screen even when the list itself is capped server-side.
   */
  readonly totalLostSessions: number | null;
};

export function LostSessionsTable({
  loading,
  sessions,
  totalLostSessions,
}: LostSessionsTableProps) {
  const [sortBy, setSortBy] = useState<SortColumn>(SortColumn.Minutes);
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

  const handleSort = (column: SortColumn, direction: SortDirection) => {
    setSortBy(column);
    setSortDir(direction);
  };

  const rows = sortRows(sessions ?? [], sortBy, sortDir).slice(
    0,
    VISIBLE_ROW_LIMIT
  );
  const description = resolveDescription(
    loading,
    sessions,
    rows.length,
    totalLostSessions
  );

  if (!(loading || sessions)) {
    return (
      <Section description={description} title="Sessions with no artifact">
        <WidgetUnavailable reason={SESSIONS_UNAVAILABLE_REASON} />
      </Section>
    );
  }

  return (
    <Section description={description} title="Sessions with no artifact">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Session</TableHead>
            <TableHead>Engineer</TableHead>
            <TableHead>Repo</TableHead>
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
        <TableBody>{renderSessionRows(loading, rows)}</TableBody>
      </Table>
    </Section>
  );
}

function SessionRow({ row }: { readonly row: LostWorkSessionRow }) {
  return (
    <TableRow>
      <TableCell className="max-w-xs">
        <div className="truncate font-medium text-sm">{row.title}</div>
        <div className="text-muted-foreground text-xs">{row.id}</div>
      </TableCell>
      <TableCell className="text-sm">{row.engineer}</TableCell>
      <TableCell className="text-sm">{row.repo}</TableCell>
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

/**
 * No lost sessions in range is the BEST possible answer this table can give, so
 * it says so rather than rendering a header over nothing.
 */
function renderSessionRows(
  loading: boolean,
  rows: readonly LostWorkSessionRow[]
) {
  if (loading) {
    return renderSkeletonRows();
  }
  if (rows.length === 0) {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell
          className="text-muted-foreground text-sm"
          colSpan={SESSION_COLUMN_COUNT}
        >
          No lost sessions in this range.
        </TableCell>
      </TableRow>
    );
  }
  return rows.map((row) => <SessionRow key={row.id} row={row} />);
}

/** Sorts on the real field, never the rendered string. */
function sortRows(
  rows: readonly LostWorkSessionRow[],
  sortBy: SortColumn,
  sortDir: SortDirection
): LostWorkSessionRow[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sortBy === SortColumn.Date) {
      return a.date.localeCompare(b.date) * direction;
    }
    return (a.minutes - b.minutes) * direction;
  });
}

/**
 * The caption reconciles with what is actually on screen. When the totals
 * rollup is there it names the real population and says how much of it the
 * table is showing; when it is not, the caption only claims what it can see.
 */
function resolveDescription(
  loading: boolean,
  sessions: readonly LostWorkSessionRow[] | null,
  visibleCount: number,
  totalLostSessions: number | null
): string {
  if (loading || !sessions) {
    return "The runs behind the numbers above.";
  }
  if (totalLostSessions === null) {
    return `Showing the ${formatCount(visibleCount)} costliest runs that yielded no artifact.`;
  }
  const population = `${formatCount(totalLostSessions)} sessions in range yielded no artifact.`;
  if (visibleCount < totalLostSessions) {
    return `${population} Showing the ${formatCount(visibleCount)} costliest.`;
  }
  return population;
}
