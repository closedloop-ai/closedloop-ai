// Sessions cost classification (FEA-3986 / FEA-4295): split a session-cost
// `groupBy(legacyLoopCostLedger, billingMode)` snapshot into subscription-covered,
// metered, and unknown spend. `totalEstimatedCost` is the complete scoped
// spend; `apiEstimatedCost` remains `metered + unknown` for compatibility.

import {
  isMeteredBillingMode,
  isSubscriptionBillingMode,
} from "@repo/api/src/types/billing-mode";
import { type Prisma, withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";

/** One `groupBy(legacyLoopCostLedger, billingMode)` cost row. */
export type SessionCostGroupRow = {
  legacyLoopCostLedger: string | null;
  billingMode: string | null;
  _sum: { estimatedCost: Prisma.Decimal | number | null };
};

/** The subscription-vs-API split of a cost snapshot (USD). */
export type SessionCostSplit = {
  /**
   * ISS-6526 — every ledger summed: `subscription + metered + unknown`. The
   * three buckets partition the snapshot (each row is classified into exactly
   * one), so this is the whole of the scoped spend, not a wider bucket.
   *
   * Owned here rather than re-added at each call site: the usage summary
   * publishes it as the Cost headline's grand total AND divides LOC/$ by it, and
   * two hand-written `subscription + api` sums are how those two figures drift
   * apart.
   */
  totalEstimatedCost: number;
  subscriptionEstimatedCost: number;
  /** Everything NOT covered by a subscription: `meteredEstimatedCost + unknownEstimatedCost`. */
  apiEstimatedCost: number;
  /**
   * ISS-4773 — CONFIRMED per-token API spend: a former loop session whose
   * stored ledger is metered, or a synced row whose `billingMode` is a metered
   * mode. This
   * is the only one of the three buckets that is money the reader can be told
   * they actually spent.
   */
  meteredEstimatedCost: number;
  /**
   * ISS-4773 — spend whose billing could NOT be determined: a legacy-null or
   * unrecognized `billingMode`, the literal `"unknown"`, or a former loop
   * session whose stored ledger is unknown. Neither confirmed metered nor confirmed
   * subscription. Reported separately so a surface can disclose it instead of
   * folding an unconfirmed figure into either real number — on a
   * subscription-heavy account this share dominates (ISS-4900).
   */
  unknownEstimatedCost: number;
};

/** Which of the three ledgers a cost row belongs to. */
export const SessionCostLedger = {
  Subscription: "subscription",
  Metered: "metered",
  Unknown: "unknown",
} as const;
export type SessionCostLedger =
  (typeof SessionCostLedger)[keyof typeof SessionCostLedger];

/**
 * Runs the session-cost `groupBy` over `where` and returns the subscription-vs-API
 * split. The DB aggregate keeps the scope bounded (never materialized row-by-row).
 */
export async function computeSessionCostSplit(
  where: Prisma.SessionDetailWhereInput
): Promise<SessionCostSplit> {
  const costRows = await withDb((db) =>
    db.sessionDetail.groupBy({
      by: ["legacyLoopCostLedger", "billingMode"],
      where,
      _sum: { estimatedCost: true },
    })
  );
  return splitSessionCost(costRows);
}

/**
 * Classifies an already-fetched cost `groupBy` snapshot into the subscription-vs-API
 * split. Separate from {@link computeSessionCostSplit} so a caller that already
 * issued the `groupBy` (the usage summary reads it alongside its other aggregates
 * in one round-trip) reuses that snapshot instead of re-querying.
 */
export function splitSessionCost(
  costRows: SessionCostGroupRow[]
): SessionCostSplit {
  let subscriptionEstimatedCost = 0;
  let meteredEstimatedCost = 0;
  let unknownEstimatedCost = 0;
  for (const row of costRows) {
    const estimatedCost = toNumber(row._sum.estimatedCost);
    const ledger = classifyCostRow(row);
    if (ledger === SessionCostLedger.Subscription) {
      subscriptionEstimatedCost += estimatedCost;
    } else if (ledger === SessionCostLedger.Metered) {
      meteredEstimatedCost += estimatedCost;
    } else {
      unknownEstimatedCost += estimatedCost;
    }
  }
  return {
    totalEstimatedCost:
      subscriptionEstimatedCost + meteredEstimatedCost + unknownEstimatedCost,
    subscriptionEstimatedCost,
    // Preserved verbatim: the not-subscription-covered bucket is still the sum of
    // the two non-subscription ledgers, so every pre-ISS-4773 consumer (the
    // shipped Cost card) reads the identical number it always did.
    apiEstimatedCost: meteredEstimatedCost + unknownEstimatedCost,
    meteredEstimatedCost,
    unknownEstimatedCost,
  };
}

/**
 * ISS-4773 — the three-way ledger for one cost row.
 *
 * A session that a Loop materialized was classified by its loop's
 * `apiKeySource`, ignoring `billingMode`. ISS-12435 removed Loops and stored that
 * classification on the session (`legacyLoopCostLedger`), so such a row keeps
 * its ledger. Every other row is classified by its synced `billingMode`, and
 * `unknown` is reached for a legacy-null mode, the literal `"unknown"`, or any
 * value outside the two known sets.
 */
function classifyCostRow(row: SessionCostGroupRow): SessionCostLedger {
  const legacyLedger = toSessionCostLedger(row.legacyLoopCostLedger);
  if (legacyLedger !== null) {
    return legacyLedger;
  }
  if (isSubscriptionBillingMode(row.billingMode)) {
    return SessionCostLedger.Subscription;
  }
  return isMeteredBillingMode(row.billingMode)
    ? SessionCostLedger.Metered
    : SessionCostLedger.Unknown;
}

/**
 * The stored former-loop ledger, or null when the row has none. A stored value
 * outside the three ledgers reads as unknown, never as a confirmed bucket.
 */
function toSessionCostLedger(value: string | null): SessionCostLedger | null {
  if (value === null) {
    return null;
  }
  return isSessionCostLedger(value) ? value : SessionCostLedger.Unknown;
}

export function isSessionCostLedger(value: string): value is SessionCostLedger {
  return (Object.values(SessionCostLedger) as string[]).includes(value);
}
