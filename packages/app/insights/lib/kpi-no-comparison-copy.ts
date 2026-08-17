import { KpiDeltaBasis } from "@closedloop-ai/loops-api/insights";

// Copy constants for the KPI delta-slot "No comparison" chip (ISS-4995). Kept in
// a lightweight module so the reason string is an importable SSOT — tests, the
// dashboard row, and the Insights tile read the same literal instead of each
// re-declaring it. Mirrors `branches/lib/branch-headline-copy.ts`, which does the
// same job for the branch-detail headline cards (FEA-4241).

/**
 * Tooltip + screen-reader reason for a KPI whose producer computes no
 * period-over-period comparison at all.
 *
 * The shared `KpiDeltaPlaceholder` default (`NO_COMPARISON_LABEL`) says the
 * comparison is unavailable "for this range", which points the reader at the
 * range control, the one thing that cannot help here. `merged` and `cost` carry
 * live deltas in the very same response, so their prior period plainly exists;
 * `kloc` and `pr-size` are blank on cloud because we never work the comparison
 * out. Changing the range, or waiting for more history, will not produce one.
 *
 * Three review threads shaped the exact words:
 *
 * 1. It must not be a near-twin of the sentence it replaces. The first draft,
 *    "A prior-period comparison isn't available for this metric yet.", differed
 *    from the range sentence by about two words, so a reader hovering two tiles
 *    side by side would not register that they had been told different things.
 *    What separates the two is the CLAIM, not the vocabulary: the range sentence
 *    reports that something is unavailable, this one says we never work it out.
 *    So it drops "prior-period" and "available" and says the plain thing.
 * 2. It uses ONE noun for the concept, and that noun is "comparison"
 *    (ISS-4995 review). The chip beside it reads "No comparison" and a screen
 *    reader announces the two back to back, so an earlier draft that said
 *    "trend" here had one control naming one thing two ways. "comparison" is
 *    also the noun the branch-detail card's sentence uses next door
 *    (`branches/lib/branch-headline-copy.ts`), so the whole affordance now
 *    speaks with one vocabulary wherever it renders.
 * 3. It does not hedge with "from this data" (ISS-4995 review). That phrase was
 *    added to keep the sentence honest on desktop, where the SAME tile is fed by
 *    the cloud routes in Cloud mode and the local store in Local mode, so an
 *    unscoped claim could flip to a live comparison when the user signs out. But
 *    only one mode's tooltip is ever on screen, so the contradiction it guarded
 *    against is invisible to the reader, while "this data" is our word for the
 *    response behind the tile and reads as vague rather than scoped. "for this
 *    metric" already carries the scope the reader can act on.
 *
 * "yet" carries the admission that the gap is ours, the same way the branch
 * card's sentence does, without spelling out which side of the wire it sits on.
 */
export const KPI_NOT_COMPUTED_REASON =
  "We don't calculate a comparison for this metric yet.";

/**
 * Tooltip + screen-reader sentence for a KPI with no delta to show, or
 * `undefined` to keep `KpiDeltaPlaceholder`'s reason-agnostic default.
 *
 * Exhaustive over `KpiDeltaBasis`, so a new basis cannot ship without a decision
 * about what the reader is told. `Computed` maps to `undefined` deliberately: on
 * a metric we do compare, an absent delta really is a fact about the window (no
 * prior period for the range, or a prior base too near zero to divide by), which
 * is what the default sentence already says.
 */
export const KPI_NO_COMPARISON_REASON: Record<
  KpiDeltaBasis,
  string | undefined
> = {
  [KpiDeltaBasis.Computed]: undefined,
  [KpiDeltaBasis.NotComputed]: KPI_NOT_COMPUTED_REASON,
};

/**
 * Resolve the delta-slot reason for one KPI.
 *
 * `undefined` — either the producer predates ISS-4995 and sent no basis, or the
 * KPI itself is absent — falls back to the default sentence. An older producer
 * genuinely does not tell us which of the two cases it is, and guessing would
 * reintroduce exactly the wrong-cause claim this resolver exists to remove.
 *
 * The `Object.hasOwn` guard is load-bearing, not defensive noise (wongk review).
 * `deltaBasis` is a wire field: it arrives as parsed JSON from either producer,
 * so the declared type constrains nothing at runtime. A plain index would return
 * an INHERITED property for `"__proto__"` or `"constructor"` — `Object.prototype`
 * or the `Object` function, neither of which is a string — and the caller hands
 * that straight to `TooltipContent` as a React child, which throws rather than
 * falling back. The same guard makes a basis value a future producer adds (which
 * this build's map cannot know) degrade to the reason-agnostic default instead.
 */
export function kpiNoComparisonReason(
  deltaBasis: KpiDeltaBasis | undefined
): string | undefined {
  if (
    deltaBasis === undefined ||
    !Object.hasOwn(KPI_NO_COMPARISON_REASON, deltaBasis)
  ) {
    return undefined;
  }
  return KPI_NO_COMPARISON_REASON[deltaBasis];
}
