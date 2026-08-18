import type { CategoryBucket } from "@closedloop-ai/loops-api/insights";

/**
 * DB-summed token columns for the Insights token KPIs and the token-distribution
 * chart, over the selected period. Summed in the database rather than
 * materializing every token row to reduce in JS.
 */
export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * ISS-5004: the module that owns how session token columns become the CLOUD
 * Insights token numbers, because the two readers of those columns disagree by
 * design and that disagreement has to be stated somewhere a reader will find it.
 *
 * Scope, stated precisely (review thread): this owns the cloud producer. Desktop
 * derives the same four buckets inline in
 * `apps/desktop/src/main/database/local-insights.ts`, so this is not yet the ONE
 * module for both surfaces; calling it that would have been a claim the code does
 * not back. Hoisting the desktop copy onto this module is a real follow-up, not
 * something to assert away in a docstring.
 *
 * The "Tokens" KPI counts {@link countedTokens} — input + output, cache
 * EXCLUDED. That is correct and is pinned elsewhere as a hard invariant (the
 * desktop golden oracle asserts `input + output == kpi:tokens` exactly), so it
 * is not the side that moves.
 *
 * The distribution chart decomposes {@link tokenDistributionBuckets} — the same
 * two classes PLUS cache read and cache write. Also correct: cache volume is real
 * work and worth charting, and collapsing it away to force agreement would delete
 * information to fix a labelling problem.
 *
 * What was actually wrong was the presentation. A chart titled "Token
 * distribution" sitting directly beneath a card titled "Tokens" reads as the
 * decomposition OF that card, and it is not — with cache included the chart's
 * population is wider by exactly {@link cacheTokens}, which on a cache-heavy
 * harness is the large majority of it. Neither said so. The card is now titled
 * "Input + output tokens" and the chart "All tokens by class", and the info copy
 * reconciles them explicitly; see `packages/app/insights/lib/tile-catalog.ts` and
 * `metric-info.ts`. (An earlier draft of this comment put a "69x" figure here as
 * fact with no population named — dropped rather than left unverifiable.)
 *
 * Both quantities are derived here from one `TokenTotals`, so the relationship
 * between them is a property this module asserts — the distribution's slices sum
 * to {@link countedTokens} + {@link cacheTokens} — rather than an accident of two
 * derivations that happen to read the same columns today. The invariant is stated
 * over the buckets the chart actually renders, not over a separate total helper:
 * a helper nothing ships could drift from the shipped derivation without any test
 * noticing, which is the opposite of the guarantee this module exists to give.
 */
export function countedTokens(totals: TokenTotals): number {
  return totals.inputTokens + totals.outputTokens;
}

/** Cache read + cache write — the "Cache saved" KPI, and the classes that make
 *  the distribution chart's population wider than the "Tokens" card's. */
export function cacheTokens(totals: TokenTotals): number {
  return totals.cacheReadTokens + totals.cacheWriteTokens;
}

/**
 * Slices for the token-distribution chart. The parts DEFINE the whole here: the
 * chart's population is whatever these four buckets sum to, so it cannot be
 * rounded or filtered independently of the slices drawn for it — and that sum is
 * {@link countedTokens} + {@link cacheTokens}, which is the reconciliation the
 * chart's title and info copy state to the reader.
 */
export function tokenDistributionBuckets(
  totals: TokenTotals
): CategoryBucket[] {
  return [
    { key: "input", label: "Input", value: totals.inputTokens },
    { key: "output", label: "Output", value: totals.outputTokens },
    { key: "cache-read", label: "Cache read", value: totals.cacheReadTokens },
    {
      key: "cache-write",
      label: "Cache write",
      value: totals.cacheWriteTokens,
    },
  ];
}
