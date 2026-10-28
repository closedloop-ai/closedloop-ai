export const ModelPricingCurrency = {
  Usd: "USD",
} as const;
export type ModelPricingCurrency =
  (typeof ModelPricingCurrency)[keyof typeof ModelPricingCurrency];

export const ModelPricingSource = {
  PricingTableV1: "pricing_table_v1",
  GenaiPricesV1: "genai_prices_v1",
  /**
   * ISS-7762: the cost came from `UNKNOWN_MODEL_FALLBACK_TIER`
   * (`@repo/cost/harness-cost-parity`), NOT from a rate the price library
   * confirmed — genai-prices had no entry for the model id at all. Its own
   * docstring calls that tier "a parity floor, not a verified rate", so
   * stamping such a row `genai_prices_v1` claims a provenance the platform
   * does not have. Every session on a model newer than the pinned price table
   * lands here, so the population grows with each model release.
   *
   * A reader MUST treat this as "priced, but unverified": the arithmetic is
   * exact for the tier applied, the tier itself is a guess.
   */
  FallbackTierV1: "fallback_tier_v1",
} as const;
export type ModelPricingSource =
  (typeof ModelPricingSource)[keyof typeof ModelPricingSource];

/**
 * ISS-7762: the session-rollup precedence, WEAKEST provenance first — the SINGLE
 * owner of that order.
 *
 * A session's `cost_source` summarizes a set of per-model rows that need not
 * agree. Whichever member appears first here wins, so a session mixing a
 * fallback floor with a library-confirmed rate reports the floor: part of its
 * total is a guess, and one verified rate must not launder the aggregate.
 *
 * Both session rollups (`updateSessionCostRollup` and its set-based twin
 * `updateSessionCostRollupBatch`) build their SQL CASE ladder by iterating this
 * array, so the order lives in ONE place. Previously each encoded it
 * separately — one in argument order, one in WHEN order — which meant adding a
 * source, or reordering the arguments, could silently invert precedence in one
 * rollup and not the other.
 */
export const MODEL_PRICING_SOURCE_WEAKEST_FIRST = [
  ModelPricingSource.FallbackTierV1,
  ModelPricingSource.GenaiPricesV1,
  ModelPricingSource.PricingTableV1,
] as const;
