/**
 * ISS-8554 / PLN-1853 Phase 2 — the published cost fields, from the three SQL
 * ledgers.
 *
 * `sessionCostSplit.sql` returns exactly three ledgers, because three is what
 * the classification produces: subscription-covered, confirmed metered, and
 * unclassified. The response contract publishes five fields over those three,
 * and this module is the only place that derives the extra two. That
 * single-ownership matters — `usage-cost-split.ts` says so about its own total:
 * two hand-written sums are how the headline and the breakdown drift apart.
 *
 * ON THE `api` MISNOMER (ISS-8559). `apiEstimatedCost` does NOT mean API-billed
 * spend. Both the current type and producer define it as "everything not covered
 * by a subscription" — `metered + unknown` — so it includes spend we could not
 * classify at all. The Cost card's "API-billed" lane renders
 * `meteredEstimatedCost`, not this field. ISS-8559 proposes narrowing
 * `apiEstimatedCost` to mean what `metered` means today and retiring the
 * "metered" name entirely; until it lands, this module reproduces the existing
 * meaning exactly, because a read path is the wrong place to unilaterally change
 * what a published field means.
 */

import type { AgentSessionCostSplitFields } from "@repo/api/src/types/agent-session-cost-split";
import type { PriorUsageFigures } from "./usage-comparison";
import type { UsageSqlCostSplit, UsageSqlTotals } from "./usage-sql-reader";

/**
 * A ledger that classified no rows holds zero dollars.
 *
 * This is NOT the D4 coercion the LOC rule rejects. There, a pull request with
 * unknown line counts is dropped and counted, because treating unknown as 0
 * would understate the numerator with no surviving signal. Here the ledgers
 * partition a population that has already been counted: "nothing classified as
 * subscription" means subscription spend was zero, which is a fact rather than
 * an absence. The reader keeps the null so this decision is made once, here,
 * where it can be argued with.
 */
function ledger(value: number | null): number {
  return value ?? 0;
}

/**
 * The five published cost fields.
 *
 * `totalEstimatedCost` is summed over all three ledgers HERE and nowhere else.
 * `meteredEstimatedCost` and `unknownEstimatedCost` are optional in the contract
 * only for version skew — a Desktop predating ISS-4773 cannot split the bucket,
 * and `undefined` there means "cannot split", never "nothing was billed". This
 * producer can always split, so it always emits both.
 */
export function toCostSplitFields(
  split: UsageSqlCostSplit
): AgentSessionCostSplitFields {
  const subscription = ledger(split.subscriptionCost);
  const metered = ledger(split.meteredCost);
  const unknown = ledger(split.unclassifiedCost);
  return {
    totalEstimatedCost: subscription + metered + unknown,
    subscriptionEstimatedCost: subscription,
    // See the module header: this is "not subscription-covered", not
    // "API-billed", until ISS-8559 changes it.
    apiEstimatedCost: metered + unknown,
    meteredEstimatedCost: metered,
    unknownEstimatedCost: unknown,
  };
}

/**
 * The prior window's comparable figures, for the EXISTING
 * `foldUsageComparison`.
 *
 * The fold is already pure arithmetic over two periods, so it is reused rather
 * than reimplemented — only the reads move to SQL. Rebuilding it would be a
 * second copy of every percent-movement rule, which is the drift this whole
 * change is trying to remove rather than relocate.
 *
 * `totalTokens` is all four counters, not the uncached pair. ISS-7175 moved the
 * tile's basis to all four, and a baseline that read only two would leave every
 * cache token out of the prior period alone — reporting a large fabricated rise
 * on a flat one.
 *
 * The prior `mergedPrCount` is deliberately not here. It reaches the fold from
 * the delivery pass, which already holds it.
 */
export function toPriorUsageFigures(
  totals: UsageSqlTotals,
  split: UsageSqlCostSplit
): PriorUsageFigures {
  const cost = toCostSplitFields(split);
  return {
    totalSessions: totals.sessionCount,
    totalTokens:
      totals.inputTokens +
      totals.outputTokens +
      totals.cacheReadTokens +
      totals.cacheWriteTokens,
    meteredEstimatedCost: cost.meteredEstimatedCost ?? 0,
    apiEstimatedCost: cost.apiEstimatedCost,
    totalEstimatedCost: cost.totalEstimatedCost,
  };
}
