"use client";

import type { SpendOutcomeRow } from "@repo/api/src/types/session-analytics";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { SegmentedBar } from "@repo/design-system/components/ui/primitives/segmented-bar";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  type ClassifiedSpendOutcome,
  SPEND_OUTCOME_LABELS,
  SPEND_OUTCOME_ORDER,
  SpendOutcome,
} from "@closedloop-ai/loops-api/insights";
import {
  formatSessions,
  formatUsd,
  formatUsdExact,
} from "@/lib/analytics/format";
import { UnavailableValue } from "@/lib/analytics/unavailable";
import { WidgetState } from "./widget-state";

/**
 * The factual anchor of the screen, and the thing everything below is derived
 * from: period spend split by how the originating session ENDED.
 *
 * It is keyed on the canonical `SpendOutcome` classifier and nothing else, the
 * same key the Lost-work screen uses, so the two can never disagree about which
 * sessions failed.
 *
 * "Outcome unknown" is its own bucket. A session with no recorded outcome
 * genuinely means none was ever observed. Folding it into "Ended clean" would
 * overstate healthy spend; folding it into "Ended with error" would invent
 * waste that was never seen.
 */

/**
 * Outcome -> bar color. "Outcome unknown" takes `--chart-3`, the same token the
 * Lost-work screen gives its Unattributed class, because they are the same
 * sessions seen as dollars instead of hours. Clean spend is achromatic: it is
 * the denominator the other two are read against, so it recedes.
 */
// Keyed on `ClassifiedSpendOutcome`, not the full `SpendOutcome` union: this
// screen is driven by `outcomeOf`, which folds a non-terminal session into
// `Unknown` and can never emit `Running`. Keying on the narrower type keeps this
// map exhaustive AND stops the screen growing a bucket its own data cannot fill
// (ISS-4463 added `Running` for the Agents lens, which resolves terminality
// itself from `sessionEndedAt`).
const OUTCOME_BAR_CLASS: Record<ClassifiedSpendOutcome, string> = {
  [SpendOutcome.Clean]: "bg-muted-foreground/25",
  [SpendOutcome.Errored]: "bg-chart-1",
  [SpendOutcome.Unknown]: "bg-chart-3",
};

const UNAVAILABLE_REASON =
  "The session-spend read did not return for this range, so the outcome split cannot be shown.";

type OutcomeDisplayRow = {
  readonly outcome: ClassifiedSpendOutcome;
  readonly label: string;
  readonly usd: number;
  readonly sessions: number;
};

export function SpendByOutcome({
  state,
  totalSpendUsd,
  outcomes,
}: {
  readonly state: WidgetState;
  readonly totalSpendUsd: number | undefined;
  readonly outcomes: readonly SpendOutcomeRow[] | undefined;
}) {
  const ready = state === WidgetState.Ready && totalSpendUsd !== undefined;
  return (
    <Section
      // The total is only claimed once it has actually arrived. Naming a figure
      // while the read is in flight, or after it failed, is the same lie as a
      // fabricated zero.
      description={
        ready
          ? `${formatUsd(totalSpendUsd)} of session spend in range, keyed on how each session ended. Measured, not estimated.`
          : "Session spend in range, keyed on how each session ended. Measured, not estimated."
      }
      title="Spend by session outcome"
    >
      {renderSplit({ outcomes, ready, state })}
    </Section>
  );
}

function renderSplit({
  outcomes,
  ready,
  state,
}: {
  readonly outcomes: readonly SpendOutcomeRow[] | undefined;
  readonly ready: boolean;
  readonly state: WidgetState;
}) {
  if (state === WidgetState.Loading) {
    return <Skeleton className="h-24 w-full rounded-md" />;
  }
  if (!(ready && outcomes)) {
    return <UnavailableValue reason={UNAVAILABLE_REASON} />;
  }
  const rows = orderRows(outcomes);
  // `value` stays UNROUNDED so the bar's geometry and its own percentages are
  // computed from the real amounts — rounding to whole dollars first drops a
  // sub-dollar bucket out of the bar while the row beneath still reports its
  // cents. `formattedValue` carries the currency, so the legend reads "$84"
  // rather than a bare "84" under a section about money.
  const segments = rows.map((row) => ({
    colorClassName: OUTCOME_BAR_CLASS[row.outcome],
    formattedValue: formatUsd(row.usd),
    key: row.outcome,
    label: row.label,
    value: row.usd,
  }));
  // The parts define the whole. Deriving the grand total separately lets it
  // disagree with the segments drawn under it, which is a composition bar
  // quietly lying about what it is composed of.
  const barTotal = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div className="space-y-4">
      <SegmentedBar segments={segments} total={barTotal} />
      <dl className="divide-y divide-border">
        {rows.map((row) => (
          <div
            className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0"
            key={row.outcome}
          >
            <dt className="text-sm">{row.label}</dt>
            <dd className="flex shrink-0 items-baseline gap-3 tabular-nums">
              <span className="text-muted-foreground text-xs">
                {formatSessions(row.sessions)}
              </span>
              <span className="font-medium text-sm">
                {formatUsdExact(row.usd)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Fixed presentation order, so the buckets never reshuffle between reads.
 *
 * A bucket the response did not carry had no sessions in range, so its zero is
 * a measurement. A read that FAILED never reaches here: it settles as
 * unavailable above and renders a dash instead.
 */
function orderRows(rows: readonly SpendOutcomeRow[]): OutcomeDisplayRow[] {
  const byOutcome = new Map(rows.map((row) => [row.outcome, row]));
  return SPEND_OUTCOME_ORDER.map((outcome) => {
    const row = byOutcome.get(outcome);
    return {
      label: SPEND_OUTCOME_LABELS[outcome],
      outcome,
      sessions: row?.sessions ?? 0,
      usd: row?.usd ?? 0,
    };
  });
}
