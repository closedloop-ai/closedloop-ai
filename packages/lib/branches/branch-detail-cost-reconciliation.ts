/**
 * ISS-6949 — resolve the figure the Branch-detail "Cost breakdown" card presents,
 * and whether its phase rows account for that figure.
 *
 * The card total is the branch's CANONICAL ATTRIBUTED COST — the same value the
 * Sessions & timeline tab takes as its authoritative input — never the
 * phase-attribution rollup residue, which understated it by 12x-388x on 8 of 10
 * sampled branches. The rows keep their rollup values and carry the disclosure
 * when they do not account for the total.
 *
 * WHY THE ROW COMPARISON IS AT DISPLAY PRECISION, not micro-cents. The two
 * operands come from different pipelines with different rounding:
 *   - the rollup total is quantized twice — once per priced event
 *     (`attributeBranchSessionActivity` accumulates `usdToMicroCents(costUsd)`
 *     off `token_events`) and again per session (`allocateSessionCostShares`
 *     rounds `Σ micro / branchCount`),
 *   - the attributed total is a raw float sum over a DIFFERENT table
 *     (`token_usage` / session cost) with no rounding at all.
 * Micro-cent equality therefore fails on healthy branches from ~50 priced turns
 * upward, which would star nearly every card and make the disclosure meaningless.
 * `roundDisplayedCost` rounds through the same `Intl.NumberFormat` `formatCost`
 * renders with, so a discrepancy is reported exactly when the reader could see
 * one — and NOT via `Math.round(usd * 100)`, which disagrees with that formatter
 * at half-cent boundaries (FEA-4294).
 */

import { roundDisplayedCost } from "@repo/api/src/agent-session-filters";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
} from "@repo/api/src/types/branch-phase-attribution";
import { hasCompleteBranchMetricEventCost } from "./branch-phase-cost-contributions";

/** The resolved card total plus the availability of the total and of its rows. */
export type ResolvedPhaseTotal = {
  totalUsd: number;
  totalComplete: boolean;
  rowsComplete: boolean;
  /**
   * Whether the rows' own cost evidence is whole, INDEPENDENT of whether it
   * sums to the total. `rowsComplete` folds two unrelated shortfalls — evidence
   * the producer could not price, and priced evidence that disagrees with the
   * canonical total — and only the first is activity with unavailable cost.
   * Separated so the outcome layer can attach the sentence that is true rather
   * than one sentence for both (tamsinb review, PR #7912).
   */
  rowEvidenceComplete: boolean;
};

/** `null` declines: no figure this can present as the branch's cost. */
export function resolveDetailPhaseTotal(
  attribution: BranchPhaseAttributionResult,
  attributedCostUsd: number | null,
  rollupTotalUsd: number
): ResolvedPhaseTotal | null {
  if (attributedCostUsd === null) {
    // No attributed cost: a zero rollup agrees with "nothing priced", while a
    // priced rollup contradicts it and is not presentable as the branch total.
    return rollupTotalUsd === 0 ? settledZeroTotal(attribution) : null;
  }
  if (!(Number.isFinite(attributedCostUsd) && attributedCostUsd >= 0)) {
    return null;
  }
  if (attributedCostUsd === 0) {
    // A canonical priced zero over priced rows is the same contradiction as a
    // null total over priced rows.
    return rollupTotalUsd > 0 ? null : settledZeroTotal(attribution);
  }
  const rowEvidenceComplete = hasWholeRowEvidence(attribution);
  return {
    totalUsd: attributedCostUsd,
    totalComplete: true,
    rowEvidenceComplete,
    rowsComplete:
      rowEvidenceComplete &&
      roundDisplayedCost(rollupTotalUsd) ===
        roundDisplayedCost(attributedCostUsd),
  };
}

/** Whether every priced thing the rows are built from was actually priced. */
function hasWholeRowEvidence(
  attribution: BranchPhaseAttributionResult
): boolean {
  return (
    coverageClaimsWholeCost(attribution.coverage) &&
    // `hasCompleteBranchMetricEventCost` is vacuously true for an empty segments
    // array, so non-vacuity is required explicitly rather than inferred from a
    // predicate that cannot see it.
    attribution.segments.length > 0 &&
    hasCompleteBranchMetricEventCost(attribution)
  );
}

/**
 * A zero total short-circuits the card before any phase row renders, so the
 * header marker is the only disclosure channel left. Keep it whenever coverage
 * is not Complete rather than presenting an undisclosed settled zero.
 */
function settledZeroTotal(
  attribution: BranchPhaseAttributionResult
): ResolvedPhaseTotal {
  const settled =
    attribution.coverage.completeness ===
    BranchPhaseAttributionCompleteness.Complete;
  return {
    totalUsd: 0,
    totalComplete: settled,
    rowsComplete: settled,
    rowEvidenceComplete: settled,
  };
}

/**
 * A lifecycle gap leaves phase boundaries unknown, not cost: since ISS-12709
 * (#8970) every local PR is unobserved, so Desktop reports it on every branch
 * with no unpriced activity. The coverage carries one reason by precedence, so
 * a cost gap ranked below the lifecycle one is hidden here; the row disclosure
 * then falls to `DefaultIncomplete`, which stays true for either cause.
 */
function coverageClaimsWholeCost(
  coverage: BranchPhaseAttributionResult["coverage"]
): boolean {
  if (coverage.completeness === BranchPhaseAttributionCompleteness.Complete) {
    return true;
  }
  return (
    coverage.completeness === BranchPhaseAttributionCompleteness.Partial &&
    coverage.reason ===
      BranchPhaseAttributionCompletenessReason.LifecycleIncomplete
  );
}
