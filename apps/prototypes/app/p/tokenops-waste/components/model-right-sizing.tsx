"use client";

import { Section } from "@repo/design-system/components/ui/layout/section";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import {
  DataState,
  formatCompact,
  formatCount,
  formatPercent,
  formatUsdExact,
  NO_VALUE,
} from "@/lib/analytics/format";
import {
  MIN_GRADED_SESSIONS,
  MODEL_VERDICT_LABELS,
  type ModelRow,
  ModelVerdict,
  modelRows,
} from "../mock";

/**
 * Model right-sizing. The spend, the error-outcome spend, and the session count
 * are facts; the verdict is a judgment, so it renders as a plain colored word
 * rather than a badge and always sits beside the numbers it was derived from.
 *
 * The row that matters is the ungraded one. A model with too few sessions gets
 * "Not enough data" and a dash for confidence, NOT a cheerful "Right-sized" and
 * not a 0% that would read as certainty. Its error-outcome spend, meanwhile, is
 * a real `$0.00`, because zero failed sessions is a measurement. Those three
 * treatments have to be visibly different from each other, and from the
 * skeleton state, on a screen whose whole subject is waste.
 */

const SKELETON_ROW_COUNT = 5;
const MODEL_COLUMN_COUNT = 6;
const NUMERIC_CELL_CLASS = "text-right tabular-nums";

/** Exhaustive, so a new verdict fails typecheck instead of rendering unstyled. */
const VERDICT_VARIANT: Record<
  ModelVerdict,
  "error" | "muted" | "success" | "warning"
> = {
  [ModelVerdict.Overpowered]: "warning",
  [ModelVerdict.RightSized]: "success",
  [ModelVerdict.Underpowered]: "error",
  [ModelVerdict.Ungraded]: "muted",
};

export function ModelRightSizing({
  dataState,
}: {
  readonly dataState: DataState;
}) {
  return (
    <Section
      description={`Spend and error-outcome spend are measured. The verdict is a judgment, and a model with fewer than ${MIN_GRADED_SESSIONS} sessions in range does not get one.`}
      title="Model right-sizing"
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Model</TableHead>
            <TableHead className={NUMERIC_CELL_CLASS}>Spend</TableHead>
            <TableHead className={NUMERIC_CELL_CLASS}>
              Ended with error
            </TableHead>
            <TableHead className={NUMERIC_CELL_CLASS}>Sessions</TableHead>
            <TableHead className={NUMERIC_CELL_CLASS}>Median tokens</TableHead>
            <TableHead>Verdict</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dataState === DataState.Loading
            ? renderSkeletonRows()
            : modelRows.map((row) => (
                <ModelTableRow key={row.model} row={row} />
              ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function ModelTableRow({ row }: { readonly row: ModelRow }) {
  const graded = row.verdict !== ModelVerdict.Ungraded;
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium text-sm">{row.model}</div>
        <div className="text-muted-foreground text-xs">
          {formatUsdExact(row.usdPerSession)} per session
        </div>
      </TableCell>
      <TableCell className={NUMERIC_CELL_CLASS}>
        {formatUsdExact(row.usd)}
      </TableCell>
      {/* A real $0.00 here means zero failed sessions, which is a finding. It is
          rendered as a value, never as the unavailable dash. */}
      <TableCell className={NUMERIC_CELL_CLASS}>
        {formatUsdExact(row.errorOutcomeUsd)}
      </TableCell>
      <TableCell className={NUMERIC_CELL_CLASS}>
        {formatCount(row.sessions)}
      </TableCell>
      <TableCell className={NUMERIC_CELL_CLASS}>
        {formatCompact(row.medianTokens)}
      </TableCell>
      <TableCell>
        <ToneLabel variant={VERDICT_VARIANT[row.verdict]}>
          {MODEL_VERDICT_LABELS[row.verdict]}
        </ToneLabel>
        <div className="text-muted-foreground text-xs">
          {graded
            ? `${formatPercent(row.confidencePct)} of spend ended in error`
            : `${NO_VALUE} needs ${formatCount(MIN_GRADED_SESSIONS)} sessions to grade`}
        </div>
      </TableCell>
    </TableRow>
  );
}

function renderSkeletonRows() {
  return Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder rows with no identity of their own
    <TableRow key={index}>
      {Array.from({ length: MODEL_COLUMN_COUNT }, (__, cell) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder cells
        <TableCell key={cell}>
          <Skeleton className="h-5 w-full rounded" />
        </TableCell>
      ))}
    </TableRow>
  ));
}
