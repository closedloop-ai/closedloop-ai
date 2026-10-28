import { z } from "zod";

/**
 * Round-trip savings attributable to Session Mesh (ISS-11756, ISS-11761).
 *
 * THE UNIT OF COST IS THE ROUND-TRIP, NOT THE TOKEN. Every tool call is a full
 * model turn that re-reads the whole cached context, so at the fleet's measured
 * median context (~210k tokens) the content of a shared finding is a rounding
 * error next to the round-trips spent finding it. A savings model denominated in
 * tokens understates by roughly three orders of magnitude; ISS-11761 was filed in
 * tokens and corrected to round-trips on operator direction 2026-09-30.
 *
 * Every operand here is MEASURED AND PASSED IN. Nothing in this module carries a
 * sampled constant: the round-trip price comes from the org's own usage records
 * and the trips-saved distribution from its own discovery chains, so a sample
 * taken on one machine can never become the product's idea of what work costs.
 *
 * The price itself is not computed here. `apps/api`'s `readRoundTripCost` takes
 * it from the `estimated_cost` column, which `@repo/cost`'s `computeTokenCost`
 * already attributes across all four token buckets; a second price table in this
 * module would drift from that one and quietly re-price the fleet.
 */
export const SessionMeshSavingsPercentile = {
  Median: "median",
  Mean: "mean",
  P90: "p90",
} as const;
export type SessionMeshSavingsPercentile =
  (typeof SessionMeshSavingsPercentile)[keyof typeof SessionMeshSavingsPercentile];

/**
 * A distribution over round-trips a recipient did not have to spend, one entry
 * per reported percentile.
 *
 * Nullable rather than defaulted: an org with too few observed discovery chains
 * has an UNKNOWN distribution, and unknown is not zero. A zero here would render
 * "$0.00 saved", which is a measurement this repo has not taken.
 */
export const sessionMeshTripsSavedValidator = z.object({
  median: z.number().nonnegative().finite().nullable(),
  mean: z.number().nonnegative().finite().nullable(),
  p90: z.number().nonnegative().finite().nullable(),
  /**
   * Discovery chains the distribution was computed over; its own denominator.
   * Nullable because a value that is not a whole non-negative number is not a
   * count of anything — unknown, never a fabricated 0.
   */
  observations: z.number().int().nonnegative().nullable(),
});
export type SessionMeshTripsSaved = z.infer<
  typeof sessionMeshTripsSavedValidator
>;

export const sessionMeshSavingsValidator = z.object({
  median: z.number().nonnegative().finite().nullable(),
  mean: z.number().nonnegative().finite().nullable(),
  p90: z.number().nonnegative().finite().nullable(),
  costPerRoundTripUsd: z.number().nonnegative().finite().nullable(),
  tripsSaved: sessionMeshTripsSavedValidator,
  /**
   * Deliveries the savings is multiplied over; stated so no figure is bare.
   * Nullable for the same reason `observations` is: a negative, fractional or
   * non-finite delivery count is a corrupt operand, not a quantity of zero.
   */
  engagedDeliveries: z.number().int().nonnegative().nullable(),
});
export type SessionMeshSavings = z.infer<typeof sessionMeshSavingsValidator>;

function isUsableCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Total estimated savings at each reported percentile.
 *
 * `engagedDeliveries` is the multiplier rather than `delivered`, because a
 * delivery nobody acted on saved nobody anything — engagement is the observed
 * reuse signal ISS-11435 produces, and it is counted once per engaged recipient.
 *
 * A corrupt multiplier makes the projection unknown, not free. Clamping a
 * negative count to 0 published `$0.00 saved` — a number nobody measured, and
 * the same distinction collapse the Mesh card was already fixed for once. The
 * measured price and the usable percentiles beside it still publish; only the
 * operand that is genuinely absent reports `null`.
 */
export function sessionMeshSavings(input: {
  engagedDeliveries: number | null;
  tripsSaved: SessionMeshTripsSaved;
  costPerRoundTripUsd: number | null;
}): SessionMeshSavings {
  const { engagedDeliveries, tripsSaved, costPerRoundTripUsd } = input;
  const deliveries = usableWholeCount(engagedDeliveries);
  const price = isUsableCount(costPerRoundTripUsd) ? costPerRoundTripUsd : null;
  const saved = sanitizeTripsSaved(tripsSaved);
  const project = (trips: number | null): number | null => {
    if (deliveries === null || price === null || trips === null) {
      return null;
    }
    const value = deliveries * trips * price;
    return Number.isFinite(value) ? value : null;
  };
  return {
    median: project(saved.median),
    mean: project(saved.mean),
    p90: project(saved.p90),
    costPerRoundTripUsd: price,
    tripsSaved: saved,
    engagedDeliveries: deliveries,
  };
}

/** A value that is not a whole non-negative number is not a count. */
function usableWholeCount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * The distribution is echoed back only in values it could actually hold.
 *
 * `project()` already refuses a nonsensical trip count, but echoing the raw one
 * put the returned payload beyond `sessionMeshSavingsValidator`, so this
 * module's own output failed this module's own boundary.
 */
function sanitizeTripsSaved(
  tripsSaved: SessionMeshTripsSaved
): SessionMeshTripsSaved {
  const trip = (value: number | null): number | null =>
    isUsableCount(value) ? value : null;
  return {
    median: trip(tripsSaved.median),
    mean: trip(tripsSaved.mean),
    p90: trip(tripsSaved.p90),
    observations: usableWholeCount(tripsSaved.observations),
  };
}
