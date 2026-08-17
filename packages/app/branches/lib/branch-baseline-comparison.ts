import type { BranchKpi, BranchMetricBasis } from "@repo/api/src/types/branch";
import {
  BranchBaselineScope,
  BranchKpiState,
} from "@repo/api/src/types/branch";
import { isComparableDelta } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { BranchNoComparisonReason } from "./branch-no-comparison-reason";

/**
 * ISS-4686 — the single gate between a `BranchKpi` baseline and a rendered
 * verdict.
 *
 * A "+12% better" chip is a claim that the value above it moved. That claim only
 * holds when the KPI's own value and baseline were measured over the SAME
 * population (`comparisonScope`) and measure the SAME thing (`basis`) as the
 * figure beside them. Neither holds on branch detail: every `BranchAnalytics`
 * KPI is a corpus aggregate while the cards show ONE branch, and
 * `leadTimeForChangeMs` is first-commit → merge while the lead-time card value is
 * first-session → merge.
 *
 * No producer emits any baseline today, so the live reason is always
 * `NotComputed`; the corpus/basis branches are the guard that catches the first
 * baseline someone wires without reading ISS-4686.
 *
 * The card therefore never reads `baseline30d`/`deltaPct` itself — it renders
 * whatever this resolver returns, so there is no path from a raw KPI to a delta
 * chip that skips the check. Producers can only build a baseline through
 * `BranchKpiWithBaseline`, which demands the scope; consumers can only render one
 * through here, which demands the match.
 *
 * The percentage itself is DERIVED here rather than taken from the wire: the
 * producer's `deltaPct` is an unverifiable second copy of a number this resolver
 * has already checked both operands of, so trusting it would let an inconsistent
 * or non-finite payload render a verdict that contradicts the value above it.
 */

export type BranchBaselineComparison =
  /** `deltaPct` is DERIVED here from the checked value/baseline pair and is always finite — never the producer's own `deltaPct`. */
  | { comparable: true; deltaPct: number }
  | { comparable: false; reason: BranchNoComparisonReason };

export type BranchBaselineComparisonInput = {
  /** The KPI carrying the baseline; undefined when analytics is not wired. */
  kpi: BranchKpi | undefined;
  /** False when the card renders "No data" instead of a figure. */
  hasValue: boolean;
  /**
   * The NUMBER the card renders, or null when it renders something else (a
   * qualitative state such as "In progress", or nothing). A delta only describes
   * the figure above it when the KPI was computed over that same figure, so this
   * is checked against `kpi.value` before any verdict is allowed.
   */
  valueNumber: number | null;
  /** The POPULATION the card's own value covers. */
  valueScope: BranchBaselineScope;
  /** What the card's own value measures. */
  valueBasis: BranchMetricBasis;
  /** What the KPI measures — pass `BRANCH_KPI_METRIC_BASIS[<field>]`, not a literal. */
  baselineBasis: BranchMetricBasis;
};

/**
 * For a card whose VALUE covers the keyed population, the KPI comparison scopes
 * that are a like-for-like comparison. Exhaustive over `BranchBaselineScope`: a new
 * scope fails typecheck here until someone decides what it may be compared
 * against, rather than defaulting into a verdict.
 */
const COMPARABLE_BASELINE_SCOPES: Record<
  BranchBaselineScope,
  readonly BranchBaselineScope[]
> = {
  [BranchBaselineScope.Corpus]: [BranchBaselineScope.Corpus],
  [BranchBaselineScope.Branch]: [BranchBaselineScope.Branch],
};

/**
 * The scope values THIS build understands. A scope string outside the set is a
 * newer producer's addition, not a mismatch — routing it through the mismatch
 * branch would print a concrete reason ("covers all branches") about a
 * population we cannot actually name.
 */
const KNOWN_BASELINE_SCOPES: ReadonlySet<string> = new Set<string>(
  Object.values(BranchBaselineScope)
);

function isKnownBaselineScope(value: unknown): value is BranchBaselineScope {
  return typeof value === "string" && KNOWN_BASELINE_SCOPES.has(value);
}

/**
 * Whether the KPI's own value IS the number on the card. Compared with a
 * relative tolerance because the two are computed independently (a producer's
 * server-side ratio vs the client's, over the same inputs), so bit-exact
 * equality would reject a legitimate comparison over float noise.
 */
const VALUE_MATCH_RELATIVE_TOLERANCE = 1e-9;

function describesSameValue(kpiValue: number | null, cardValue: number) {
  if (kpiValue == null) {
    return false;
  }
  const scale = Math.max(1, Math.abs(kpiValue), Math.abs(cardValue));
  return (
    Math.abs(kpiValue - cardValue) <= VALUE_MATCH_RELATIVE_TOLERANCE * scale
  );
}

function notComparable(
  reason: BranchNoComparisonReason
): BranchBaselineComparison {
  return { comparable: false, reason };
}

/**
 * Resolve whether a KPI's 30-day baseline may be rendered as a verdict beside a
 * card's value, and why not when it may not.
 */
export function resolveBranchBaselineComparison({
  kpi,
  hasValue,
  valueNumber,
  valueScope,
  valueBasis,
  baselineBasis,
}: BranchBaselineComparisonInput): BranchBaselineComparison {
  // A delta beside a "No data" value compares to nothing (wongk review on
  // #4148), so an unavailable value short-circuits every other check.
  if (!hasValue) {
    return notComparable(BranchNoComparisonReason.ValueUnavailable);
  }
  // A baseline of 0, or a non-finite one, has no percentage change to express —
  // `(value - 0) / 0` is ±Infinity or NaN. That is "no comparison computed", not
  // a verdict, so it is rejected here rather than escaping as an Infinity rise
  // the delta chip would colour green (wongk + logical-QA review on #4242).
  if (
    kpi == null ||
    kpi.state !== BranchKpiState.Available ||
    kpi.value == null ||
    kpi.baseline30d == null ||
    !Number.isFinite(kpi.baseline30d) ||
    kpi.baseline30d === 0
  ) {
    return notComparable(BranchNoComparisonReason.NotComputed);
  }
  if (!isKnownBaselineScope(kpi.comparisonScope)) {
    return notComparable(BranchNoComparisonReason.UnknownScope);
  }
  if (!COMPARABLE_BASELINE_SCOPES[valueScope].includes(kpi.comparisonScope)) {
    return notComparable(BranchNoComparisonReason.ScopeMismatch);
  }
  if (baselineBasis !== valueBasis) {
    return notComparable(BranchNoComparisonReason.BasisMismatch);
  }
  // Last gate: matching population and measurement still don't make `deltaPct`
  // a statement about THIS card. It is `(kpi.value - baseline30d) / baseline30d`,
  // so it only describes the number above it when that number IS `kpi.value` —
  // and the cards compute their own figures rather than rendering `kpi.value`.
  if (valueNumber == null || !describesSameValue(kpi.value, valueNumber)) {
    return notComparable(BranchNoComparisonReason.ValueMismatch);
  }
  // The wire's own `deltaPct` is NOT trusted (wongk review on #4242): a payload
  // carrying value 21, baseline 20 and deltaPct -50 clears every gate above and
  // would render the exact opposite verdict, and a non-finite one would reach the
  // chip as a coloured Infinity. Everything needed to state the change is already
  // here and already checked, so the percentage is derived from the number the
  // card renders and the baseline it was checked against.
  const deltaPct = ((valueNumber - kpi.baseline30d) / kpi.baseline30d) * 100;
  if (!isComparableDelta(deltaPct)) {
    return notComparable(BranchNoComparisonReason.NotComputed);
  }
  return { comparable: true, deltaPct };
}
