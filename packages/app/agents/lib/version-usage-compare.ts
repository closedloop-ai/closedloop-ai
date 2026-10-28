import { formatDeltaPct, pctDelta } from "@closedloop-ai/loops-api/insights";
import type {
  AgentComponentKind,
  ComponentVersion,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentVersionUsage } from "@repo/api/src/types/agent-component-version-usage";
import {
  formatCostPreciseOrDash,
  formatCountOrDash,
  formatLocPerDollar,
  formatTokenCountOrDash,
} from "@repo/app/shared/lib/format-utils";
import {
  DELTA_SENTIMENT_CAPTION,
  type DeltaSentiment,
  deltaSentiment,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { coerceHash } from "./version-label";
import {
  type VersionUsageMetric,
  VersionUsageMetricUnit,
  versionUsageMetrics,
} from "./version-usage-view";

/**
 * ISS-10468 — the SIDE-BY-SIDE version compare's derivation.
 *
 * Second half of Marisol Ashgrove's ISS-10341 ruling ("they should be
 * family-scoped; then drill downs for specific versions / side-by-side version
 * compare"). ISS-10341 made the detail state ONE family-scoped population, which
 * is right and which left "did this revision actually do better than the last
 * one" unanswerable; ISS-10467 restored one revision's own figures, and this
 * puts two of them beside each other with the change between them.
 *
 * ## The one rule this module exists to hold
 *
 * `buildBranchMetricComparison` returned an unavailable delta whenever EITHER
 * side was partial, which on real data was every non-count Branches metric — and
 * #7017 then deleted the comparison slot from every card in every window rather
 * than fix that gate (root `AGENTS.md`, and ISS-10540 reversing it). This module
 * does not repeat it:
 *
 *   - A FLOOR operand still yields a delta. Both figures are real measurements,
 *     so the subtraction is real; what a bound costs is exactness, not the
 *     figure, so the delta is published as {@link
 *     VersionCompareDeltaState.Approximate} with the shortfall named beside it.
 *   - A GENUINE ZERO change is its own state, rendered as "No change" and never
 *     folded into "no comparison". Those are different facts and a reader acts on
 *     them differently.
 *   - Only a genuinely ABSENT operand stops the delta, and then the reason NAMES
 *     the side and the figure that is missing rather than dashing the slot. The
 *     two columns still render whatever each one measured — the compare withholds
 *     a delta it cannot compute, never a value it holds.
 *
 * The loading and failed states are the PANEL's, not this module's: they are
 * facts about the request, and a derivation over two entries cannot tell a
 * pending read from an absent figure.
 *
 * ## Why it derives from the drill-down's rows and not from the entries
 *
 * Every row here comes from {@link versionUsageMetrics}, which already owns the
 * label, the kind gate, the coverage decoding and the formatter. Reading
 * `AgentComponentVersionUsage` again would be a second derivation of "this
 * version's figure" — the drift class that produced ISS-10341 in the first
 * place — and any of those four choices diverging puts a delta on screen that
 * does not belong to the two numbers beside it.
 */

/** What the compare could say about the change between two versions. */
export const VersionCompareDeltaState = {
  /** Both operands measured and neither was a floor. */
  Computed: "computed",
  /**
   * Both operands measured and at least one was a FLOOR, so the change is real
   * but inexact in an undetermined direction. Published with its shortfall
   * stated — never suppressed.
   */
  Approximate: "approximate",
  /** One side has no measured figure at all. {@link reason} names which. */
  Incomparable: "incomparable",
} as const;
export type VersionCompareDeltaState =
  (typeof VersionCompareDeltaState)[keyof typeof VersionCompareDeltaState];

/** Which way a computed change moved. A GLYPH channel, never hue alone. */
export const VersionCompareDirection = {
  Up: "up",
  Down: "down",
  Unchanged: "unchanged",
} as const;
export type VersionCompareDirection =
  (typeof VersionCompareDirection)[keyof typeof VersionCompareDirection];

/**
 * The direction stated in WORDS, for the accessibility tree and for any reader
 * who cannot resolve the arrow.
 *
 * WCAG 2.2 SC 1.4.1: colour is never the only channel here, and neither is the
 * glyph. An exhaustive `Record` so a fourth direction cannot ship unnamed.
 */
export const VERSION_COMPARE_DIRECTION_WORD: Record<
  VersionCompareDirection,
  string
> = {
  [VersionCompareDirection.Up]: "up",
  [VersionCompareDirection.Down]: "down",
  [VersionCompareDirection.Unchanged]: "unchanged",
};

/** What a genuine zero change reads as — a measurement, not an absence. */
export const VERSION_COMPARE_NO_CHANGE_LABEL = "No change";

/**
 * The sentence beside a delta at least one of whose operands was a floor.
 *
 * Published rather than swallowed: the subtraction is over two real
 * measurements, and a directional figure is usable where a blank is not. What
 * the sentence removes is only the claim of exactness.
 */
export const VERSION_COMPARE_BOUNDED_CAVEAT =
  "At least one figure behind this change was read from a bounded sample, so the change is approximate rather than exact.";

/** The compare's own delta over one metric row. */
export type VersionCompareDelta =
  | {
      state:
        | typeof VersionCompareDeltaState.Computed
        | typeof VersionCompareDeltaState.Approximate;
      /** Signed change, candidate minus baseline, in the row's own unit. */
      change: number;
      direction: VersionCompareDirection;
      /**
       * The change's MAGNITUDE formatted in the row's own unit — unsigned,
       * because the sign travels as the direction glyph plus its word. A zero
       * change renders {@link VERSION_COMPARE_NO_CHANGE_LABEL}.
       */
      magnitude: string;
      /**
       * The percent change when a baseline supports one, else null. Null is NOT
       * "no comparison": the absolute change beside it is still real. `pctDelta`
       * declines a near-zero baseline and a magnitude past its ±999% ceiling.
       */
      percent: string | null;
      /**
       * Whether the movement is an improvement, a regression, or neither, from
       * the row's declared polarity. Only `LOC / $` ever scores.
       */
      sentiment: DeltaSentiment;
      /** The visible verdict word ("better"/"worse"), or null for no verdict. */
      verdict: string | null;
      /** {@link VERSION_COMPARE_BOUNDED_CAVEAT} when approximate, else null. */
      disclosure: string | null;
    }
  | {
      state: typeof VersionCompareDeltaState.Incomparable;
      /** WHICH operand is absent, in words. Never a bare placeholder. */
      reason: string;
    };

/** One row of the side-by-side readout. */
export type VersionCompareRow = {
  key: string;
  label: string;
  /** The baseline revision's cell, exactly as the drill-down renders it. */
  baseline: VersionCompareCell;
  /** The selected revision's cell, exactly as the drill-down renders it. */
  candidate: VersionCompareCell;
  delta: VersionCompareDelta;
};

/** One rendered figure in a compare column. */
export type VersionCompareCell = {
  value: string;
  /** Whether {@link value} is a measurement, for the muted no-data slot. */
  measured: boolean;
};

/**
 * The side-by-side rows for two versions of one component.
 *
 * `baseline` is the revision compared AGAINST — adjacent, not necessarily older
 * — and `candidate` the one the reader selected, so a positive change means "the
 * selected revision is higher". Both entries may
 * be `undefined` — a pending or absent read — and every row then reports itself
 * incomparable while still rendering each column's own dash, which is the
 * drill-down's not-computed state and not a zero.
 */
export function versionCompareRows(
  kind: AgentComponentKind,
  baselineEntry: AgentComponentVersionUsage | undefined,
  candidateEntry: AgentComponentVersionUsage | undefined
): readonly VersionCompareRow[] {
  const baselineRows = versionUsageMetrics(kind, baselineEntry);
  const candidateRows = versionUsageMetrics(kind, candidateEntry);
  const rows: VersionCompareRow[] = [];
  for (const [index, candidate] of candidateRows.entries()) {
    // Index-paired rather than looked up by key: both sides come from the SAME
    // function with the same kind, so the two lists are the same rows in the same
    // order by construction. A key lookup here would silently drop a row if that
    // ever stopped being true, which is the quieter failure.
    const baseline = baselineRows[index];
    rows.push({
      key: candidate.key,
      label: candidate.label,
      baseline: { value: baseline.value, measured: baseline.measured },
      candidate: { value: candidate.value, measured: candidate.measured },
      delta: compareDelta(baseline, candidate),
    });
  }
  return rows;
}

/**
 * The compare's default baseline: the revision ADJACENT to the selected one —
 * the immediately older one where there is one, the immediately newer one when
 * the selection is already the oldest on offer, and null only when the
 * selection is the sole revision or is not among the options.
 *
 * "Did this revision do better than the last one" is the question the compare
 * exists to answer, so the adjacent prior revision is the answer's default
 * second operand. Version history arrives NEWEST-FIRST (`versionLabelForHash`),
 * so older is the next index up.
 *
 * The newer-neighbour fallback is what keeps the compare live on the oldest
 * revision instead of leaving the affordance dead there, so what this returns
 * is the adjacent revision and NOT necessarily an older one. The operator ruled
 * that the COPY is what changes rather than this behaviour (marisolashgrove
 * 2026-10-01: "3. copy", then "Ruling 3, use 'other' instead of 'older'"), so
 * the fallback and the selector's freedom to pick any revision both stand, and
 * the two strings that used to assert the age — the baseline column header in
 * `version-usage-panel.tsx` and `incomparableReason` below — now say "other".
 */
export function defaultCompareBaselineHash(
  options: readonly ComponentVersion[],
  selectedHash: string | null
): string | null {
  if (selectedHash === null) {
    return null;
  }
  const index = options.findIndex(
    (version) => coerceHash(version.hash) === selectedHash
  );
  if (index === -1) {
    return null;
  }
  const older = options[index + 1] ?? options[index - 1];
  const hash = coerceHash(older?.hash);
  return hash.length > 0 ? hash : null;
}

function compareDelta(
  baseline: VersionUsageMetric,
  candidate: VersionUsageMetric
): VersionCompareDelta {
  // A genuinely ABSENT operand is the only thing that stops a delta, and the
  // reason names it. `raw` is already normalized to `number | null`, so a
  // version-skewed producer's omitted field reads as the same absence a `null`
  // does rather than as a third state.
  if (baseline.raw === null || candidate.raw === null) {
    return {
      state: VersionCompareDeltaState.Incomparable,
      reason: incomparableReason(baseline, candidate),
    };
  }
  const rawChange = candidate.raw - baseline.raw;
  // SELF-RECONCILIATION with the two cells beside it (tamsinb; packages/app
  // AGENTS.md "Derived arithmetic must self-reconcile"). Both columns publish a
  // ROUNDED figure, so a raw change smaller than that precision used to print a
  // direction next to two IDENTICAL cells — $20.60 and $21.40 both render "$21"
  // while the raw 0.80 rendered "up $1, +25%". When the cells render the same
  // string there is no change AT THE PRECISION THIS READOUT PUBLISHES, so the
  // row states that with the same label a raw zero uses, and drops the percent
  // that would contradict it. Decided by comparing the operands' OWN rendered
  // strings, never a second copy of each unit's precision: a parallel quantizer
  // would drift from the formatter it mirrors the first time one of them moves.
  const foldedFlat = rawChange !== 0 && baseline.value === candidate.value;
  const change = foldedFlat ? 0 : rawChange;
  const direction = directionOf(change);
  const bounded = baseline.bounded || candidate.bounded;
  const sentiment = deltaSentiment(change, candidate.polarity);
  return {
    state: bounded
      ? VersionCompareDeltaState.Approximate
      : VersionCompareDeltaState.Computed,
    change,
    direction,
    magnitude:
      direction === VersionCompareDirection.Unchanged
        ? VERSION_COMPARE_NO_CHANGE_LABEL
        : formatMagnitude(Math.abs(change), candidate.unit),
    // The absolute change above is the figure this row always publishes; the
    // percent is the extra that a usable baseline buys. `pctDelta` is the
    // cross-surface owner of that arithmetic and of both refusals (a near-zero
    // baseline, and the ±999% ceiling ISS-5003 declines rather than clamps), so
    // it is read rather than respelled here.
    percent: foldedFlat
      ? null
      : formatDeltaPct(pctDelta(candidate.raw, baseline.raw)),
    sentiment,
    // Always rendered, never treatment-gated. `MetricDeltaTreatment` exists
    // because `MetricCard` and the Insights badge are SHARED primitives whose
    // presentation cannot change per surface; this readout is its own, and the
    // word is what keeps the good/bad reading off hue alone (SC 1.4.1).
    verdict: DELTA_SENTIMENT_CAPTION[sentiment],
    disclosure: bounded ? VERSION_COMPARE_BOUNDED_CAVEAT : null,
  };
}

/**
 * Which side could not be measured, in words.
 *
 * Names the ROW and the SIDE, because "no comparison" alone sends a reader
 * looking for a bug: on real data most revisions legitimately have no cost or no
 * merged-PR figure, and the honest statement is which operand is missing.
 *
 * "THE OTHER REVISION", never "the older revision" (operator ruling,
 * marisolashgrove 2026-10-01: "Ruling 3, use 'other' instead of 'older'"). The
 * baseline need not be older — {@link defaultCompareBaselineHash} falls back to
 * the newer neighbour on the oldest selection, and the selector offers every
 * non-candidate revision — so naming it the older one asserted an age nothing
 * here establishes.
 */
function incomparableReason(
  baseline: VersionUsageMetric,
  candidate: VersionUsageMetric
): string {
  const label = candidate.label;
  if (baseline.raw === null && candidate.raw === null) {
    return `Neither revision has a measured ${label}, so there is no change to state.`;
  }
  if (baseline.raw === null) {
    return `The other revision has no measured ${label}, so there is nothing to compare this one against.`;
  }
  return `This revision has no measured ${label}, so there is nothing to compare against the other one.`;
}

function directionOf(change: number): VersionCompareDirection {
  if (change > 0) {
    return VersionCompareDirection.Up;
  }
  if (change < 0) {
    return VersionCompareDirection.Down;
  }
  return VersionCompareDirection.Unchanged;
}

/**
 * A NON-NEGATIVE magnitude in the row's own unit, through the same canonical
 * formatter the column values use.
 *
 * An exhaustive `Record` and not a switch chain: a unit added to
 * {@link VersionUsageMetricUnit} tomorrow fails `tsc` here until it names its
 * formatter, rather than silently inheriting the count spelling and printing a
 * dollar figure as a bare integer.
 */
const MAGNITUDE_FORMATTER: Record<
  VersionUsageMetricUnit,
  (magnitude: number) => string
> = {
  [VersionUsageMetricUnit.Count]: formatCountOrDash,
  [VersionUsageMetricUnit.LocPerDollar]: formatLocPerDollar,
  [VersionUsageMetricUnit.Tokens]: formatTokenCountOrDash,
  // The SAME cost guard the column itself renders through, at the same cents
  // precision (operator ruling, marisolashgrove 2026-10-01: "raise cost column's
  // precision"). A magnitude formatted one precision coarser than its own
  // operands is the defect that ruling answers, inverted: the cells would state
  // a move the change column rounded away. A real change too small for even 4dp
  // still reads as its own bound (`< $0.0001`) rather than the `$0.00` that
  // would say the spend did not move (ISS-4919).
  [VersionUsageMetricUnit.Usd]: formatCostPreciseOrDash,
};

function formatMagnitude(
  magnitude: number,
  unit: VersionUsageMetricUnit
): string {
  return MAGNITUDE_FORMATTER[unit](magnitude);
}
