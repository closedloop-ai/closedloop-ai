/**
 * ISS-11117: the Branches LISTING's Pensero points-per-dollar arm.
 *
 * Its own module rather than another fold inside `branch-list-metrics.ts`,
 * which is already past the file-size ceiling — and the seam is a real one:
 * every other member of the list bundle is derived from evidence this package
 * folds, while this one divides a numerator an external delivery feed supplied
 * and the API attributed.
 */

import {
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { calculateDetailPenseroPointsPerDollar } from "./branch-detail-pensero-points";
import type { BranchListMetricInput } from "./branch-list-metrics";
import { complete, notApplicable, unavailable } from "./branch-metric-results";

/**
 * ISS-11117: the cohort's Pensero points per dollar, or nothing.
 *
 * Divides the SAME `canonicalEstimatedCostUsd` scalar the canonical LOC ratio
 * divides, through the SAME kernel branch detail already uses
 * ({@link calculateDetailPenseroPointsPerDollar}) — so the points ratio cannot
 * acquire a second set of guards, a second rounding, or a second disclosure
 * vocabulary by being computed twice.
 *
 * Returns `undefined` when the producer sent no numerator, which is the state
 * the card reads as "keep rendering LOC/$". A cohort the producer could not
 * qualify yields an `Unavailable` RESULT rather than `undefined`: there IS a
 * Pensero metric for this reader, and it could not be computed — a different
 * fact from having none, and one the consumer's publishable test then routes to
 * the same LOC/$ render without claiming the numerator was absent.
 */
export function canonicalPenseroPointsPerDollarResult(
  input: BranchListMetricInput,
  /** The window's AI spend, sent when the producer folds cost itself (ISS-12346). */
  aiSpend?: BranchMetricResult<number>
): BranchMetricResult<number> | undefined {
  if (!input.penseroPoints) {
    return undefined;
  }
  if (input.cohortCoverageComplete === false) {
    return unavailable();
  }
  return calculateDetailPenseroPointsPerDollar(
    input.penseroPoints,
    aiSpend ? spendBasisResult(aiSpend) : canonicalCostBasisResult(input)
  );
}

/**
 * A MEASURED zero spend is Not applicable: the cohort genuinely cost nothing.
 *
 * A PARTIAL zero is not that fact — it is the sum of the events that carried a
 * price while others carried none, so "cost nothing" is a claim the fold cannot
 * make. `calculatePushedLocPerDollar` divides the same scalar and reaches
 * Unavailable there by keying on cost completeness; this arm has to agree, or
 * two ratios over one denominator describe it differently.
 */
function spendBasisResult(
  aiSpend: BranchMetricResult<number>
): BranchMetricResult<number> {
  if (aiSpend.value !== 0) {
    return aiSpend;
  }
  if (aiSpend.state === BranchMetricAvailability.Complete) {
    return notApplicable();
  }
  return aiSpend.state === BranchMetricAvailability.Partial
    ? unavailable()
    : aiSpend;
}

/**
 * The canonical cost scalar as a metric result, so the shared points kernel can
 * apply the denominator rules it already owns.
 *
 * The three arms are the ones {@link calculateCanonicalLocPerDollar} applies to
 * the same scalar, stated in that kernel's vocabulary: not told is Unavailable,
 * a measured zero is NotApplicable (the cohort genuinely cost nothing), and
 * anything else is the money to divide by. Deriving them here rather than
 * duplicating the ratio keeps ONE denominator decision for both numerators.
 */
function canonicalCostBasisResult(
  input: BranchListMetricInput
): BranchMetricResult<number> {
  const cost = input.canonicalEstimatedCostUsd;
  if (!(typeof cost === "number" && Number.isFinite(cost) && cost >= 0)) {
    return unavailable();
  }
  return cost === 0 ? notApplicable() : complete(cost);
}
