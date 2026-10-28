"use client";

import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import type { ModelRightSizingRow } from "@repo/api/src/types/session-analytics";
import {
  MODEL_VERDICT_LABELS,
  ModelVerdict,
} from "@repo/api/src/types/session-analytics";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { Section } from "@repo/design-system/components/ui/layout/section";
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
import { renderTableSkeletonRows } from "@/lib/analytics/table-skeleton-rows";
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
  // ISS-10691: `usd` is `SUM(tu.estimated_cost)` over the windowed sessions with
  // no billing-mode filter (`tokenops-waste-queries.ts`), so this column is the
  // governed quantity and takes its canonical phrase in place of `Spend`.
  // No alias: the phrase is 126px here and is not even the widest header in the
  // row (`Median job size (tokens)` is 151px). Headers are `whitespace-nowrap`
  // inside `overflow-x-auto`, so a container scrollbar is the only failure mode
  // available, and it starts at a 1228px viewport with the phrase against
  // 1167px without.
  const estimatedCostLabel = useFeatureFlagEnabledOptional(
    ONE_LABEL_PER_METRIC_FLAG_KEY
  )
    ? TOTAL_ESTIMATED_COST_LABEL
    : LEGACY_MODEL_RIGHT_SIZING_SPEND_LABEL;
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
              <TableHead className={NUMERIC_CELL_CLASS}>
                {estimatedCostLabel}
              </TableHead>
              <TableHead className={NUMERIC_CELL_CLASS}>
                Ended with error
              </TableHead>
              <TableHead className={NUMERIC_CELL_CLASS}>Sessions</TableHead>
              {/* The basis is named in the header, not only in the description:
                  this is the one number on the row whose meaning changes
                  entirely with which tokens were counted, and it is NOT the
                  basis behind the cost column beside it. The unit stays in the
                  header too — the cell renders a bare compact number, so
                  dropping "tokens" would leave "240k" of nothing in particular.
                  Which tokens is defined in the description (ISS-5189). */}
              <TableHead className={NUMERIC_CELL_CLASS}>
                Median job size (tokens)
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
    return renderTableSkeletonRows(SKELETON_ROW_COUNT, MODEL_COLUMN_COUNT);
  }
  if (models.length === 0) {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell
          className="text-muted-foreground text-sm"
          colSpan={MODEL_COLUMN_COUNT}
        >
          No model cost in this range.
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
      {/* `medianWorkTokens` ONLY, and the settled-unavailable dash when it is
          absent — never a fallback to the billed `medianTokens` beside it on
          the wire. `apps/api` and `apps/app` deploy separately, so this build
          can be talking to an API that predates the field; falling back would
          put billed numbers, cached reads and all, under a header and a
          description that state they are first-pass. A dash says "we do not
          have this", which is true, and is the same treatment the confidence
          cell already uses for a value that settled without one. */}
      <TableCell className={NUMERIC_CELL_CLASS}>
        {formatCompact(row.medianWorkTokens ?? null)}
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
 * cost of this model's ended in error) and has to render as `0%`.
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
  return `${formatPercent(confidencePct)} of cost ended in error`;
}

/**
 * The threshold is named whenever the server sent it. An older response that
 * predates the field falls back to the unquantified sentence rather than
 * inventing a number the server may not be using.
 *
 * The token basis is stated too, and stated exactly — including that the
 * verdict's two halves do not share one. A reader who assumed job size counted
 * replayed cache reads would draw the opposite conclusion about a cache-heavy
 * model (ISS-5189).
 *
 * It says the two columns cannot be divided into a rate rather than claiming
 * they reconcile. The billed-token count the price half uses is not rendered
 * anywhere on this table, so a reader cannot check a reconciliation claim — and
 * dividing spend by job size × sessions is off by the whole cached-read volume,
 * which on a cache-heavy fleet is most of it. Warn about the arithmetic the
 * mismatch invites instead of asserting an agreement nothing on screen shows.
 */
function describeGrading(minGradedSessions: number | undefined): string {
  const threshold =
    minGradedSessions === undefined
      ? "too few sessions in range"
      : `fewer than ${formatCount(minGradedSessions)} sessions in range`;
  return `Cost and error-outcome cost are measured. Job size counts first-pass tokens only, so replaying one cached prefix is not counted as a bigger job; the price side of the verdict divides cost by every billed token, including the cached reads this column leaves out, so these two columns do not divide into a rate. The verdict is a judgment, and a model with ${threshold} does not get one.`;
}

const LEGACY_MODEL_RIGHT_SIZING_SPEND_LABEL = "Spend";
