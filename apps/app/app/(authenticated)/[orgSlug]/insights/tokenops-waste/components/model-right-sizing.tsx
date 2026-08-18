"use client";

import type { ModelRightSizingRow } from "@repo/api/src/types/session-analytics";
import {
  MODEL_VERDICT_LABELS,
  ModelVerdict,
} from "@repo/api/src/types/session-analytics";
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
  formatCompact,
  formatCount,
  formatPercent,
  formatUsdExact,
  NO_VALUE,
} from "@/lib/analytics/format";
import { UnavailableValue } from "@/lib/analytics/unavailable";
import { WidgetState } from "./widget-state";

/**
 * Model right-sizing. The spend, the error-outcome spend, and the session count
 * are facts; the verdict is a judgment, so it renders as a plain colored word
 * rather than a badge and always sits beside the numbers it was derived from.
 *
 * The verdict is graded against the FLEET on the server, never against a magic
 * absolute here. This file only renders it.
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

const UNAVAILABLE_REASON =
  "The per-model read did not return for this range, so no model can be graded.";

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
  state,
  models,
  minGradedSessions,
}: {
  readonly state: WidgetState;
  readonly models: readonly ModelRightSizingRow[] | undefined;
  /**
   * The server's grading threshold, read off the wire rather than restated
   * here. Naming the number is what tells a reader WHEN an ungraded row will
   * start getting a verdict; "too few" just leaves them guessing.
   */
  readonly minGradedSessions: number | undefined;
}) {
  const ready = state === WidgetState.Ready && models !== undefined;
  return (
    <Section
      description={describeGrading(minGradedSessions)}
      title="Model right-sizing"
    >
      {ready || state === WidgetState.Loading ? (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Model</TableHead>
              <TableHead className={NUMERIC_CELL_CLASS}>Spend</TableHead>
              <TableHead className={NUMERIC_CELL_CLASS}>
                Ended with error
              </TableHead>
              <TableHead className={NUMERIC_CELL_CLASS}>Sessions</TableHead>
              <TableHead className={NUMERIC_CELL_CLASS}>
                Median tokens
              </TableHead>
              <TableHead>Verdict</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {renderRows({ minGradedSessions, models, ready })}
          </TableBody>
        </Table>
      ) : (
        <UnavailableValue reason={UNAVAILABLE_REASON} />
      )}
    </Section>
  );
}

function renderRows({
  models,
  ready,
  minGradedSessions,
}: {
  readonly models: readonly ModelRightSizingRow[] | undefined;
  readonly ready: boolean;
  readonly minGradedSessions: number | undefined;
}) {
  if (!(ready && models)) {
    return renderSkeletonRows();
  }
  if (models.length === 0) {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell
          className="text-muted-foreground text-sm"
          colSpan={MODEL_COLUMN_COUNT}
        >
          No model spend in this range.
        </TableCell>
      </TableRow>
    );
  }
  return models.map((row) => (
    <ModelTableRow
      key={row.model}
      minGradedSessions={minGradedSessions}
      row={row}
    />
  ));
}

function ModelTableRow({
  row,
  minGradedSessions,
}: {
  readonly row: ModelRightSizingRow;
  readonly minGradedSessions: number | undefined;
}) {
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
          {renderConfidence(row.confidencePct, minGradedSessions)}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * `confidencePct` is OMITTED for an ungraded model, so the check is against
 * `undefined` and never against falsiness: a real `0` is a measurement (no
 * spend of this model's ended in error) and has to render as `0%`.
 */
function renderConfidence(
  confidencePct: number | undefined,
  minGradedSessions: number | undefined
): string {
  if (confidencePct === undefined) {
    return minGradedSessions === undefined
      ? `${NO_VALUE} too few sessions to grade`
      : `${NO_VALUE} needs ${formatCount(minGradedSessions)} sessions to grade`;
  }
  return `${formatPercent(confidencePct)} of spend ended in error`;
}

/**
 * The threshold is named whenever the server sent it. An older response that
 * predates the field falls back to the unquantified sentence rather than
 * inventing a number the server may not be using.
 */
function describeGrading(minGradedSessions: number | undefined): string {
  const threshold =
    minGradedSessions === undefined
      ? "too few sessions in range"
      : `fewer than ${formatCount(minGradedSessions)} sessions in range`;
  return `Spend and error-outcome spend are measured. The verdict is a judgment, and a model with ${threshold} does not get one.`;
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
