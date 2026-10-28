/**
 * Cohort shapes the Sessions Cost card has to survive. Mirrors the fields the
 * real `AgentSessionUsageSummary` publishes, including the two that are OPTIONAL
 * on the wire: a Desktop predating the three-way split sends neither
 * `meteredEstimatedCost` nor `unknownEstimatedCost`, and absence there means
 * "this producer cannot split the bucket", never zero.
 *
 * The cost figures are typed NULLABLE here, deliberately, and this is WIDER than
 * today's wire contract: `totalEstimatedCost` is `number` on
 * `AgentSessionCostSplitFields`, so the producer cannot currently say "unknown"
 * at all — it can only say `0`, which is a different fact. That is a defect in
 * the contract rather than a shape this prototype should design around
 * (operator ruling, Cosimo, 2026-08-24, tracked as ISS-7900): AGENTS.md holds
 * that an internal nullable value should represent unknown rather than a
 * fabricated one, and ISS-4748 requires zero and unknown to be DISTINCT states,
 * which a non-nullable number cannot express. The card is built for the contract
 * we intend to have.
 */
export type CostCohort = {
  id: string;
  /** Gallery caption: which real situation this shape stands for. */
  caption: string;
  /** Subscription-inclusive grand total. Always published. */
  totalEstimatedCost: number | null;
  /** API-equivalent value of subscription-covered usage. Always published. */
  subscriptionEstimatedCost: number | null;
  /** Confirmed per-token API spend. Absent when the producer cannot split. */
  meteredEstimatedCost?: number;
  /** Spend whose billing mode was never determined. Absent likewise. */
  unknownEstimatedCost?: number;
  /**
   * Signed percent movement on the TOTAL basis, null when no prior window.
   *
   * NOT YET PRODUCIBLE. `AgentSessionComparisonMetric` emits `sessions`,
   * `tokens`, `meteredCost`, `apiCost` and `prsShipped` — there is no total
   * member, and nothing computes total-vs-prior-total. Headlining the total
   * therefore needs a new comparison metric plus its `assignDelta` in
   * `usage-comparison.ts`; reusing `apiCost` under a total headline is exactly
   * the basis mismatch `session-summary-deltas.ts` split those two metrics to
   * prevent. This is the one part of the proposal that is not a pure
   * presentation change.
   */
  totalDeltaPercent: number | null;
  /** Still hydrating: frame and lane structure hold, values skeleton. */
  loading?: boolean;
};

/** The window every cohort below is scoped to, echoed in the delta caption. */
export const COMPARISON_WINDOW_LABEL = "vs. prior 30 days";

export const mockCostCohorts: readonly CostCohort[] = [
  {
    id: "production-today",
    caption:
      "Production, 30 days. The account is subscription-heavy and the non-subscription remainder is entirely unclassified, so the shipped card headlined $210 under the bare word COST.",
    totalEstimatedCost: 154_524.31,
    subscriptionEstimatedCost: 154_314.09,
    meteredEstimatedCost: 0,
    unknownEstimatedCost: 210.22,
    totalDeltaPercent: -4.2,
  },
  {
    id: "mixed-metered",
    caption:
      "A team genuinely running on API keys alongside seats. All three lanes carry real weight, which is the shape the breakdown is most useful on.",
    totalEstimatedCost: 48_920.5,
    subscriptionEstimatedCost: 31_004.18,
    meteredEstimatedCost: 16_825.4,
    unknownEstimatedCost: 1090.92,
    totalDeltaPercent: 12.8,
  },
  {
    id: "flat-window",
    caption:
      "A window that did not move. The chip renders the flat glyph and reads 0.0%, rather than the green 'less' a naive positive test produces.",
    totalEstimatedCost: 12_004.0,
    subscriptionEstimatedCost: 9880.5,
    meteredEstimatedCost: 2113.5,
    unknownEstimatedCost: 10.0,
    totalDeltaPercent: 0,
  },
  {
    id: "sub-cent-lane",
    caption:
      "A real lane too small to render at whole-dollar precision. It reads its bound, never a fabricated $0 — the exact lie this card exists to stop.",
    totalEstimatedCost: 6402.19,
    subscriptionEstimatedCost: 6402.18,
    meteredEstimatedCost: 0.004,
    unknownEstimatedCost: 0.006,
    totalDeltaPercent: -0.3,
  },
  {
    id: "no-prior-window",
    caption:
      "A real total with no prior window to compare against — a new org, or a range with nothing behind it. The slot holds and says so, rather than dropping and letting the card reflow.",
    totalEstimatedCost: 2140.75,
    subscriptionEstimatedCost: 1980.0,
    meteredEstimatedCost: 150.75,
    unknownEstimatedCost: 10.0,
    totalDeltaPercent: null,
  },
  {
    id: "unsplittable-producer",
    caption:
      "A Desktop build predating the three-way split. It publishes the total and the subscription lane but cannot separate confirmed spend from unclassified, so the card collapses to one honest remainder lane rather than inventing a zero.",
    totalEstimatedCost: 8412.66,
    subscriptionEstimatedCost: 7980.11,
    totalDeltaPercent: -1.4,
  },
  {
    id: "unreconciled-split",
    caption:
      "A producer that sent both halves, but they do not add up to the remainder they claim to partition. Presence is not enough — the card falls back to the two-lane presentation rather than repairing a bad payload into a believable lane.",
    totalEstimatedCost: 5000.0,
    subscriptionEstimatedCost: 4000.0,
    meteredEstimatedCost: 250.0,
    unknownEstimatedCost: 250.0,
    totalDeltaPercent: 3.1,
  },
  {
    id: "unpriced-cohort",
    caption:
      "Nothing in the matched cohort could be priced. The total is unknown, so nothing about the split is knowable either: the value slot takes the honest-empty dash, the lanes drop entirely, and the delta row goes with them rather than stacking a second negation.",
    totalEstimatedCost: null,
    subscriptionEstimatedCost: null,
    meteredEstimatedCost: 0,
    unknownEstimatedCost: 0,
    totalDeltaPercent: null,
  },
  {
    id: "loading",
    caption:
      "First paint. Three neutral lane rows hold the structure so it cannot pop in, and no lane is NAMED before the payload says which producer sent it.",
    totalEstimatedCost: null,
    subscriptionEstimatedCost: null,
    totalDeltaPercent: null,
    loading: true,
  },
];

/** Today's shipped card, kept beside the proposal so the change is legible. */
export const shippedCardToday = {
  label: "cost",
  value: 210.22,
  detail: "+$154,314 if billed to API",
  /** Real: the shipped card grades `apiEstimatedCost`, and that bucket fell 99%. */
  delta: "-99%",
  deltaCaption: "better vs. prior 30 days",
};

/**
 * The middle option, already built and flag-gated behind
 * `sessions-cost-billing-honesty` (default off). Headlines the CONFIRMED metered
 * figure under its own label and discloses the rest in the caption. Included so
 * the comparison is the real three-way it is, not a two-up.
 */
export const shippedHonestMode = {
  label: "API-billed Cost",
  value: 0,
  detail: "+$154,314 via subscription · $210 billing unknown",
  /**
   * No delta. Honest mode headlines `meteredEstimatedCost`, and this cohort has
   * no prior metered figure to compare against — inventing one would stack the
   * comparison against the option we are NOT proposing.
   */
  delta: null,
  deltaCaption: null,
};
