/**
 * The cost-split fields carried by every agent-session usage summary.
 *
 * Extracted from `agent-session.ts` by ISS-4773. That file is grandfathered
 * shrink-only, and this is the exact concern the ticket changes — how a matched
 * session set's spend is classified and reported — so the whole group moves out
 * together rather than growing the hot file by two more fields. `AgentSessionUsageSummary`
 * intersects this type, so every producer and consumer sees the identical shape it
 * always did.
 *
 * The classification is three-way. `subscriptionEstimatedCost` is usage covered
 * by a flat subscription or seat, priced only as a hypothetical "would have
 * cost". `meteredEstimatedCost` is spend confirmed billed to an API key.
 * `unknownEstimatedCost` is spend whose billing mode was never determined — the
 * bucket that made the Sessions Cost card misleading when it was folded into the
 * headline as definite spend.
 */
export type AgentSessionCostSplitFields = {
  /**
   * FEA-3986 — subscription-INCLUSIVE grand total, GUARANTEED equal to
   * `subscriptionEstimatedCost + apiEstimatedCost` by construction: both
   * producers derive it FROM the classified buckets read in ONE snapshot (cloud
   * sums its single `costsByLoop` groupBy; desktop folds its three cost
   * ledgers), so the headline and the breakdown can never drift apart. Both
   * surfaces MUST emit this subscription-inclusive meaning — never narrow it to
   * metered-only; the not-subscription-covered spend is `apiEstimatedCost`.
   */
  totalEstimatedCost: number;
  /** Cost on subscription-covered compute targets (loop apiKeySource === 'none') */
  subscriptionEstimatedCost: number;
  /**
   * Everything NOT covered by a subscription — `meteredEstimatedCost +
   * unknownEstimatedCost`. Meaning is unchanged since before ISS-4773 (the LOC/$
   * denominator still divides by exactly this), so the two fields below are
   * strictly additive.
   */
  apiEstimatedCost: number;
  /**
   * ISS-4773 — the CONFIRMED-metered half of `apiEstimatedCost`: spend on a
   * compute target with a real API key source, or a synced session whose
   * `billingMode` is a known metered mode. This is the only figure a surface may
   * present as money actually spent.
   *
   * OPTIONAL for version skew: an already-installed Desktop predating ISS-4773
   * omits it (its local fold published only the collapsed bucket). A consumer
   * that cannot read it MUST fall back to its pre-ISS-4773 presentation rather
   * than treat the absence as a zero — `undefined` here means "this producer
   * cannot split the bucket", never "nothing was billed".
   */
  meteredEstimatedCost?: number;
  /**
   * ISS-4773 — the UNCLASSIFIED half of `apiEstimatedCost`: spend whose billing
   * mode was never determined (legacy-null, the literal `"unknown"`, an
   * unrecognized value, or a source loop with no resolvable `apiKeySource`).
   * Neither confirmed metered nor confirmed subscription.
   *
   * Published so a surface can DISCLOSE the share rather than fold it into a
   * headline as definite cost.
   *
   * NOTE (stage review): `subscription_unknown` is NOT in this bucket. It is a
   * member of `SUBSCRIPTION_MODES`, so `billingLedger` routes it to
   * `subscriptionEstimatedCost` and it never reached `apiEstimatedCost`. Do not
   * cite it as evidence of how large the unclassified share is.
   *
   * `meteredEstimatedCost + unknownEstimatedCost === apiEstimatedCost` whenever
   * both are present (to within float-accumulation drift — the three figures are
   * independently summed, so consumers must reconcile with a tolerance, never
   * exact equality). Optional for the same version-skew reason as above.
   */
  unknownEstimatedCost?: number;
};
