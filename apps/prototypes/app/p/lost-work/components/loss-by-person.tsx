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
  formatCount,
  formatHours,
  formatPercent,
  formatSessions,
  NO_VALUE,
} from "@/lib/analytics/format";
import {
  LOSS_CLASS_LABELS,
  minutesToHours,
} from "@/lib/analytics/session-fixture";
import { type PersonRow, personRows } from "../mock";

/**
 * The coaching table, and the reason this screen exists.
 *
 * The systemic/behavioral split is expressed STRUCTURALLY, not with a color or
 * a caption: the coachable columns and the not-your-fault columns sit under two
 * separate spanning group headers, divided by a rule, and the second group is
 * rendered at lower emphasis. There is no combined total anywhere in the row,
 * so no reading of this table can add an org-wide rate limit onto a person's
 * record.
 *
 * Every rate carries its denominator in the same cell. "15%" alone is useless
 * for coaching; "15%, 9 of 62 sessions" is a conversation.
 *
 * The anomaly signal is each person against their OWN earlier baseline, not
 * against the team, because ranking people against each other just surfaces
 * whoever ran the most sessions.
 */

const SortColumn = {
  Actionable: "actionable",
  Baseline: "baseline",
  Rate: "rate",
  Systemic: "systemic",
  Unattributed: "unattributed",
} as const;
type SortColumn = (typeof SortColumn)[keyof typeof SortColumn];

const SKELETON_ROW_COUNT = 6;
const NUMERIC_CELL_CLASS = "text-right tabular-nums";
const GROUP_DIVIDER_CLASS = "border-border border-l";

export function LossByPerson({ dataState }: { readonly dataState: DataState }) {
  const [sortBy, setSortBy] = useState<SortColumn>(SortColumn.Actionable);
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const baselineAvailable = dataState !== DataState.Degraded;

  const handleSort = (column: SortColumn, direction: SortDirection) => {
    setSortBy(column);
    setSortDir(direction);
  };

  const rows = sortRows(personRows, sortBy, sortDir, baselineAvailable);

  return (
    <Section
      description={
        baselineAvailable
          ? "Coachable loss on the left, everything the engineer did not cause on the right. The two are never added together."
          : "Coachable loss on the left, everything the engineer did not cause on the right. The baseline rollup did not load for this range, so that column reads as unavailable rather than as no change."
      }
      title="Loss by engineer"
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead rowSpan={2}>Engineer</TableHead>
            <TableHead className="text-right" colSpan={3} scope="colgroup">
              Actionable, coachable
            </TableHead>
            <TableHead
              className={`text-right ${GROUP_DIVIDER_CLASS}`}
              colSpan={2}
              scope="colgroup"
            >
              Not attributable to the engineer
            </TableHead>
          </TableRow>
          <TableRow className="hover:bg-transparent">
            <SortableColumnHeader
              className={NUMERIC_CELL_CLASS}
              column={SortColumn.Actionable}
              label="Lost"
              onSort={handleSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              className={NUMERIC_CELL_CLASS}
              column={SortColumn.Rate}
              label="Loss rate"
              onSort={handleSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              className={NUMERIC_CELL_CLASS}
              column={SortColumn.Baseline}
              label="vs own baseline"
              onSort={handleSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              className={`${NUMERIC_CELL_CLASS} ${GROUP_DIVIDER_CLASS}`}
              column={SortColumn.Systemic}
              label="Systemic"
              onSort={handleSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              className={NUMERIC_CELL_CLASS}
              column={SortColumn.Unattributed}
              label="Unattributed"
              onSort={handleSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {dataState === DataState.Loading
            ? renderSkeletonRows()
            : rows.map((row) => (
                <PersonTableRow
                  baselineAvailable={baselineAvailable}
                  key={row.engineer}
                  row={row}
                />
              ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function PersonTableRow({
  row,
  baselineAvailable,
}: {
  readonly row: PersonRow;
  readonly baselineAvailable: boolean;
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium text-sm">{row.engineer}</div>
        {/* The dominant cause is named WITH its class. The engineer cell spans
            both column groups, so an unqualified "Usage limit" sitting under a
            name would read as something that person did, which is the exact
            misattribution this table is built to prevent. */}
        <div className="text-muted-foreground text-xs">
          {row.dominantCause
            ? `${row.dominantCause}, ${LOSS_CLASS_LABELS[row.dominantCauseClass].toLowerCase()}`
            : "No loss recorded"}
        </div>
      </TableCell>
      <TableCell className={NUMERIC_CELL_CLASS}>
        <span className="font-medium">
          {formatHours(minutesToHours(row.actionableMinutes))}
        </span>
      </TableCell>
      <TableCell className={NUMERIC_CELL_CLASS}>
        <div>{formatPercent(row.actionableRatePct)}</div>
        {/* The denominator rides with every rate. A percentage on its own can
            not start a coaching conversation. */}
        <div className="text-muted-foreground text-xs">
          {formatCount(row.actionableSessions)} of{" "}
          {formatSessions(row.sessionCount)}
        </div>
      </TableCell>
      <TableCell className={NUMERIC_CELL_CLASS}>
        <BaselineDelta
          available={baselineAvailable}
          deltaPts={row.baselineDeltaPts}
        />
      </TableCell>
      {/* Lower emphasis, behind a rule. Same numbers, different class of fact. */}
      <TableCell
        className={`${NUMERIC_CELL_CLASS} ${GROUP_DIVIDER_CLASS} text-muted-foreground`}
      >
        <div>{formatHours(minutesToHours(row.systemicMinutes))}</div>
        <div className="text-xs">{formatSessions(row.systemicSessions)}</div>
      </TableCell>
      <TableCell className={`${NUMERIC_CELL_CLASS} text-muted-foreground`}>
        <div>{formatHours(minutesToHours(row.unattributedMinutes))}</div>
        <div className="text-xs">
          {formatSessions(row.unattributedSessions)}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * The anomaly cell. A verdict word always accompanies the color, so the
 * good/bad reading never depends on hue alone (WCAG 2.2 SC 1.4.1).
 *
 * Three genuinely different answers, three different renderings:
 *   unavailable      -> a quiet dash, because the rollup did not load
 *   too little data  -> a dash with a reason, because a thin half proves nothing
 *   no change        -> a real "0 pts", because holding steady is a finding
 */
function BaselineDelta({
  deltaPts,
  available,
}: {
  readonly deltaPts: number | null;
  readonly available: boolean;
}) {
  if (!available) {
    return (
      <span
        className="text-muted-foreground"
        title="Baseline rollup unavailable"
      >
        {NO_VALUE}
      </span>
    );
  }
  if (deltaPts === null) {
    return (
      <span
        className="text-muted-foreground"
        title="Too few sessions in the earlier half to set a baseline"
      >
        {NO_VALUE}
      </span>
    );
  }
  if (deltaPts === 0) {
    return <span className="text-muted-foreground">0 pts, held steady</span>;
  }
  const worse = deltaPts > 0;
  return (
    <ToneLabel variant={worse ? "error" : "success"}>
      {worse ? "+" : ""}
      {deltaPts} pts {worse ? "worse" : "better"}
    </ToneLabel>
  );
}

function renderSkeletonRows() {
  return Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder rows with no identity of their own
    <TableRow key={index}>
      {Array.from({ length: PERSON_COLUMN_COUNT }, (__, cell) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder cells
        <TableCell key={cell}>
          <Skeleton className="h-5 w-full rounded" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

const PERSON_COLUMN_COUNT = 6;

/**
 * Sorts on the underlying numeric field, never the rendered string, so "9.5 h"
 * does not sort before "10.0 h". A row whose baseline is unavailable sorts to
 * the end in both directions rather than being graded as a zero.
 */
function sortRows(
  rows: readonly PersonRow[],
  sortBy: SortColumn,
  sortDir: SortDirection,
  baselineAvailable: boolean
): PersonRow[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, sortBy, baselineAvailable);
    const right = sortValue(b, sortBy, baselineAvailable);
    if (left === null && right === null) {
      return a.engineer.localeCompare(b.engineer);
    }
    if (left === null) {
      return 1;
    }
    if (right === null) {
      return -1;
    }
    return (left - right) * direction;
  });
}

function sortValue(
  row: PersonRow,
  sortBy: SortColumn,
  baselineAvailable: boolean
): number | null {
  if (sortBy === SortColumn.Rate) {
    return row.actionableRatePct;
  }
  if (sortBy === SortColumn.Baseline) {
    return baselineAvailable ? row.baselineDeltaPts : null;
  }
  if (sortBy === SortColumn.Systemic) {
    return row.systemicMinutes;
  }
  if (sortBy === SortColumn.Unattributed) {
    return row.unattributedMinutes;
  }
  return row.actionableMinutes;
}
