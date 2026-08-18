// Sessions cost classification (FEA-3986 / FEA-4295): split a session-cost
// `groupBy(sourceLoopId, billingMode)` snapshot into subscription-covered vs
// API-billed spend. ONE implementation, shared by the usage-summary headline
// cards (service.ts) and the delivery KLOC/$ denominator
// (`delivery-metrics.ts`), so the two can never drift (SSOT).
//
// Classification (ISS-4773: THREE ledgers, matching the desktop producer's
// long-standing metered/subscription/unknown fold). Loop-originated rows (a
// `sourceLoopId`) are keyed by the linked loop's `apiKeySource` — `none` ⇒
// subscription-covered, a real source ⇒ metered, absent ⇒ unknown. DESKTOP_SYNC
// rows (no source loop) are keyed by their synced `billingMode`: a
// subscription/seat mode ⇒ subscription, a metered mode ⇒ metered, anything else
// (the literal "unknown", legacy null, an unrecognized future value) ⇒ unknown.
//
// `apiEstimatedCost` is retained UNCHANGED as `metered + unknown` so no existing
// consumer moves; the two new fields are additive and let a surface stop
// presenting unconfirmed usage as confirmed spend.

import {
  isMeteredBillingMode,
  isSubscriptionBillingMode,
} from "@repo/api/src/types/billing-mode";
import { type Prisma, withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";
import { getLoopApiKeySource } from "./synced-payload";

/** apiKeySource sentinel for a loop billed against a subscription (no API cost). */
const LOOP_API_KEY_SOURCE_NONE = "none";

/** One `groupBy(sourceLoopId, billingMode)` cost row. */
export type SessionCostGroupRow = {
  sourceLoopId: string | null;
  billingMode: string | null;
  _sum: { estimatedCost: Prisma.Decimal | number | null };
};

/** The subscription-vs-API split of a cost snapshot (USD). */
export type SessionCostSplit = {
  subscriptionEstimatedCost: number;
  /**
   * Everything NOT covered by a subscription: `meteredEstimatedCost +
   * unknownEstimatedCost`. Meaning is unchanged from before ISS-4773 — the LOC/$
   * denominator and the shipped Cost card still read exactly this bucket — so
   * the two fields below are strictly additive.
   */
  apiEstimatedCost: number;
  /**
   * ISS-4773 — CONFIRMED per-token API spend: a source loop with a real
   * `apiKeySource`, or a synced row whose `billingMode` is a metered mode. This
   * is the only one of the three buckets that is money the reader can be told
   * they actually spent.
   */
  meteredEstimatedCost: number;
  /**
   * ISS-4773 — spend whose billing could NOT be determined: a legacy-null or
   * unrecognized `billingMode`, the literal `"unknown"`, or a source loop whose
   * `apiKeySource` is absent. Neither confirmed metered nor confirmed
   * subscription. Reported separately so a surface can disclose it instead of
   * folding an unconfirmed figure into either real number — on a
   * subscription-heavy account this share dominates (ISS-4900).
   */
  unknownEstimatedCost: number;
};

/** Which of the three ledgers a cost row belongs to. */
const SessionCostLedger = {
  Subscription: "subscription",
  Metered: "metered",
  Unknown: "unknown",
} as const;
type SessionCostLedger =
  (typeof SessionCostLedger)[keyof typeof SessionCostLedger];

/**
 * Runs the session-cost `groupBy` over `where` and returns the subscription-vs-API
 * split. The DB aggregate keeps the scope bounded (never materialized row-by-row).
 */
export async function computeSessionCostSplit(
  organizationId: string,
  where: Prisma.SessionDetailWhereInput
): Promise<SessionCostSplit> {
  const costsByLoop = await withDb((db) =>
    db.sessionDetail.groupBy({
      by: ["sourceLoopId", "billingMode"],
      where,
      _sum: { estimatedCost: true },
    })
  );
  return splitSessionCost(organizationId, costsByLoop);
}

/**
 * Classifies an already-fetched cost `groupBy` snapshot into the subscription-vs-API
 * split. Separate from {@link computeSessionCostSplit} so a caller that already
 * issued the `groupBy` (the usage summary reads it alongside its other aggregates
 * in one round-trip) reuses that snapshot instead of re-querying.
 */
export async function splitSessionCost(
  organizationId: string,
  costsByLoop: SessionCostGroupRow[]
): Promise<SessionCostSplit> {
  const loopApiKeySourceById = await loadLoopApiKeySources(
    organizationId,
    costsByLoop
  );
  let subscriptionEstimatedCost = 0;
  let meteredEstimatedCost = 0;
  let unknownEstimatedCost = 0;
  for (const row of costsByLoop) {
    const estimatedCost = toNumber(row._sum.estimatedCost);
    const ledger = classifyCostRow(row, loopApiKeySourceById);
    if (ledger === SessionCostLedger.Subscription) {
      subscriptionEstimatedCost += estimatedCost;
    } else if (ledger === SessionCostLedger.Metered) {
      meteredEstimatedCost += estimatedCost;
    } else {
      unknownEstimatedCost += estimatedCost;
    }
  }
  return {
    subscriptionEstimatedCost,
    // Preserved verbatim: the not-subscription-covered bucket is still the sum of
    // the two non-subscription ledgers, so every pre-ISS-4773 consumer (the LOC/$
    // denominator, the shipped Cost card) reads the identical number it always did.
    apiEstimatedCost: meteredEstimatedCost + unknownEstimatedCost,
    meteredEstimatedCost,
    unknownEstimatedCost,
  };
}

/**
 * ISS-4773 — the three-way ledger for one cost row.
 *
 * The subscription branch is byte-for-byte the pre-ISS-4773 `isSubscriptionCostRow`
 * predicate, so the subscription/non-subscription boundary does not move; the
 * change is that the non-subscription remainder is no longer assumed to be spend.
 *
 * `unknown` is reached deliberately, never as a fallthrough for a mode we simply
 * have not enumerated: a source loop with NO resolvable `apiKeySource` (the loop
 * row is gone, or its metadata carries none) cannot be called confirmed API
 * spend, and neither can a synced row whose `billingMode` is legacy-null, the
 * literal `"unknown"`, or any value outside the two known sets.
 */
function classifyCostRow(
  row: SessionCostGroupRow,
  loopApiKeySourceById: Map<string, string | null>
): SessionCostLedger {
  if (row.sourceLoopId) {
    // Loop-originated: classified by the linked loop's apiKeySource.
    const apiKeySource = loopApiKeySourceById.get(row.sourceLoopId) ?? null;
    if (apiKeySource === LOOP_API_KEY_SOURCE_NONE) {
      return SessionCostLedger.Subscription;
    }
    return apiKeySource === null
      ? SessionCostLedger.Unknown
      : SessionCostLedger.Metered;
  }
  // DESKTOP_SYNC (no source loop): classified by the synced billingMode.
  if (isSubscriptionBillingMode(row.billingMode)) {
    return SessionCostLedger.Subscription;
  }
  return isMeteredBillingMode(row.billingMode)
    ? SessionCostLedger.Metered
    : SessionCostLedger.Unknown;
}

/** Resolves each source loop's `apiKeySource` for the billing classification. */
async function loadLoopApiKeySources(
  organizationId: string,
  costsByLoop: SessionCostGroupRow[]
): Promise<Map<string, string | null>> {
  const sourceLoopIds = [
    ...new Set(costsByLoop.map((row) => row.sourceLoopId)),
  ].filter((value): value is string => value != null);
  if (sourceLoopIds.length === 0) {
    return new Map<string, string | null>();
  }
  const loops = await withDb((db) =>
    db.loop.findMany({
      where: { organizationId, id: { in: sourceLoopIds } },
      select: { id: true, metadata: true },
    })
  );
  return new Map(
    loops.map((loop) => [loop.id, getLoopApiKeySource(loop.metadata)])
  );
}
