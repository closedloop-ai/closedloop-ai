"use client";

import {
  LOSS_CLASS_LABELS,
  type LostWorkPersonRow,
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
  formatCount,
  formatHours,
  formatPercent,
  formatSessions,
  minutesToHours,
  NO_VALUE,
} from "@/lib/analytics/format";
import { WidgetUnavailable } from "@/lib/analytics/unavailable";

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

export const PEOPLE_UNAVAILABLE_REASON =
  "The per-engineer rollup did not load for this range, so no one is shown rather than everyone showing zero.";

export const BASELINE_UNSET_REASON =
  "Too few sessions in the earlier half to set a baseline";

const SortColumn = {
  Actionable: "actionable",
  Baseline: "baseline",
  Rate: "rate",
  Systemic: "systemic",
  Unattributed: "unattributed",
} as const;
type SortColumn = (typeof SortColumn)[keyof typeof SortColumn];

const SKELETON_ROW_COUNT = 6;
const PERSON_COLUMN_COUNT = 6;
const NUMERIC_CELL_CLASS = "text-right tabular-nums";
const GROUP_DIVIDER_CLASS = "border-border border-l";

type LossByPersonProps = {
  readonly loading: boolean;
  /** `null` when the per-engineer rollup settled without a value. */
  readonly people: readonly LostWorkPersonRow[] | null;
};

export function LossByPerson({ loading, people }: LossByPersonProps) {
  const [sortBy, setSortBy] = useState<SortColumn>(SortColumn.Actionable);
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

  const handleSort = (column: SortColumn, direction: SortDirection) => {
    setSortBy(column);
    setSortDir(direction);
  };

  if (!(loading || people)) {
    return (
      <Section
        description="Coachable loss on the left, everything the engineer did not cause on the right. The two are never added together."
        title="Loss by engineer"
      >
        <WidgetUnavailable reason={PEOPLE_UNAVAILABLE_REASON} />
      </Section>
    );
  }

  const rows = sortRows(people ?? [], sortBy, sortDir);

  return (
    <Section
      description="Coachable loss on the left, everything the engineer did not cause on the right. The two are never added together."
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
        <TableBody>{renderPersonRows(loading, rows)}</TableBody>
      </Table>
    </Section>
  );
}

function PersonTableRow({ row }: { readonly row: LostWorkPersonRow }) {
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
        <BaselineDelta deltaPts={row.baselineDeltaPts} />
      </TableCell>
      {/* Lower emphasis, behind a rule. Same numbers, different class of fact.
          There is deliberately no row total: the rule is what stops the eye
          adding across it. */}
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
 * `baselineDeltaPts` is nullable on the wire for exactly one reason, and the
 * two answers render differently:
 *   null -> a dash carrying the reason, because a thin earlier half proves nothing
 *   0    -> a real "0 pts", because holding steady is a finding, not a blank
 *
 * The reason is a real sr-only sentence rather than a bare `title`, which is
 * not reliably exposed to assistive tech and is unreachable by keyboard.
 */
function BaselineDelta({ deltaPts }: { readonly deltaPts: number | null }) {
  if (deltaPts === null) {
    return (
      <span className="text-muted-foreground" title={BASELINE_UNSET_REASON}>
        <span aria-hidden="true">{NO_VALUE}</span>
        <span className="sr-only">{BASELINE_UNSET_REASON}</span>
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

/**
 * An empty people list is a real ANSWER — a Me-scoped window, or a young org —
 * not a failure and not a loading state. Without a row for it the two-tier
 * group header renders with nothing underneath, which reads as broken rather
 * than as "no loss recorded". Matches the model table's muted colSpan row.
 */
function renderPersonRows(
  loading: boolean,
  rows: readonly LostWorkPersonRow[]
) {
  if (loading) {
    return renderSkeletonRows();
  }
  if (rows.length === 0) {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell
          className="text-muted-foreground text-sm"
          colSpan={PERSON_COLUMN_COUNT}
        >
          No sessions in this range.
        </TableCell>
      </TableRow>
    );
  }
  return rows.map((row) => <PersonTableRow key={row.userId} row={row} />);
}

/**
 * Sorts on the underlying numeric field, never the rendered string, so "9.5 h"
 * does not sort before "10.0 h". A row whose baseline is unset sorts to the end
 * in both directions rather than being graded as a zero.
 */
function sortRows(
  rows: readonly LostWorkPersonRow[],
  sortBy: SortColumn,
  sortDir: SortDirection
): LostWorkPersonRow[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, sortBy);
    const right = sortValue(b, sortBy);
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

function sortValue(row: LostWorkPersonRow, sortBy: SortColumn): number | null {
  if (sortBy === SortColumn.Rate) {
    return row.actionableRatePct;
  }
  if (sortBy === SortColumn.Baseline) {
    return row.baselineDeltaPts;
  }
  if (sortBy === SortColumn.Systemic) {
    return row.systemicMinutes;
  }
  if (sortBy === SortColumn.Unattributed) {
    return row.unattributedMinutes;
  }
  return row.actionableMinutes;
}
