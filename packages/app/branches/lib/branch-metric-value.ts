import {
  BranchMetricAvailability,
  type BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";

export type DisplayableBranchMetricValue = {
  partial: boolean;
  value: number;
  /**
   * The Partial arm's own sentence, carried with the value so a surface never
   * has to pick one (ISS-8551). Present exactly when `partial` is true: the
   * producer decides WHICH shortfall this figure has, and a card choosing a
   * sentence for itself can only ever describe a different one.
   */
  disclosure?: BranchMetricDisclosure;
};

/** User-visible Branch metrics must be real, non-negative JSON-safe numbers. */
export function isDisplayableBranchMetricNumber(
  value: number | null | undefined
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

/** Extracts the canonical value and partial marker for displayed Branch metrics. */
export function displayableBranchMetricValue(
  result: BranchMetricResult<number> | undefined
): DisplayableBranchMetricValue | null {
  if (
    !result ||
    (result.state !== BranchMetricAvailability.Complete &&
      result.state !== BranchMetricAvailability.Partial) ||
    !isDisplayableBranchMetricNumber(result.value)
  ) {
    return null;
  }
  return {
    partial: result.state === BranchMetricAvailability.Partial,
    value: result.value,
    ...(result.state === BranchMetricAvailability.Partial
      ? { disclosure: result.disclosure }
      : {}),
  };
}

/**
 * ISS-9730's fourth state: no defensible input existed, so there is nothing to
 * print and nothing the reader can do about it. The ONLY classification the
 * `metric-card-hide-unavailable` gate may retire a card on.
 *
 * Declared here rather than at either row, because both the Branches summary
 * strip and the Branch detail headline strip answer this question about the
 * same enum and must never answer it differently — a new `BranchMetricAvailability`
 * member added to one row's copy and missed by the other would make one strip
 * hide a card the other keeps under the same flag (review on #6830).
 *
 * `NotApplicable` is deliberately excluded: `N/A` is an answer about the
 * population, not an absence, and folding it in would collapse two states the
 * rest of this surface keeps apart.
 */
export function isNotComputableBranchMetricState(
  state: BranchMetricAvailability
): boolean {
  return (
    state === BranchMetricAvailability.Unavailable ||
    state === BranchMetricAvailability.NoData
  );
}

/**
 * Legacy flag-off extraction for Branch metric surfaces that shipped with
 * clamped complete/partial values before the metric-honesty gate.
 */
export function shippedClampedBranchMetricValue(
  result: BranchMetricResult<number> | undefined
): DisplayableBranchMetricValue | null {
  if (
    !result ||
    (result.state !== BranchMetricAvailability.Complete &&
      result.state !== BranchMetricAvailability.Partial) ||
    result.value === null
  ) {
    return null;
  }
  return {
    partial: result.state === BranchMetricAvailability.Partial,
    value: Math.max(0, result.value),
    ...(result.state === BranchMetricAvailability.Partial
      ? { disclosure: result.disclosure }
      : {}),
  };
}
