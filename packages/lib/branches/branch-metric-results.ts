import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import type { BranchListMetricInput } from "./branch-list-metrics";

/**
 * The five shapes a Branch metric result may take, in one place.
 *
 * Extracted from `branch-list-metrics.ts` (ISS-10363) so the kernel file holds
 * derivations and this one holds their vocabulary. Every metric in the bundle
 * ends at one of these constructors, which is what keeps "unknown", "not
 * applicable" and "nobody has any data" from collapsing into a shared `null` at
 * the call sites.
 */
export function complete<Value>(value: Value): BranchMetricResult<Value> {
  return { state: BranchMetricAvailability.Complete, value };
}

export function partial<Value>(
  value: Value,
  included?: number,
  total?: number,
  disclosure: BranchMetricDisclosure = BranchMetricDisclosure.DefaultIncomplete
): BranchMetricResult<Value> {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    ...(included === undefined || total === undefined
      ? {}
      : { coverage: { included, total } }),
    disclosure,
  };
}

export function unavailable<Value>(): BranchMetricResult<Value> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}

export function notApplicable<Value>(): BranchMetricResult<Value> {
  return { state: BranchMetricAvailability.NotApplicable, value: null };
}

export function noData<Value>(): BranchMetricResult<Value> {
  return { state: BranchMetricAvailability.NoData, value: null };
}

/**
 * What an empty cohort means for every metric that short-circuits on it.
 *
 * No data only when the producer actually established the cohort is empty. When
 * it could not qualify the population at all
 * ({@link BranchListMetricInput.cohortCoverageComplete} false), the honest answer
 * is Unavailable — the metric is unknown, not zero.
 */
export function emptyCohortResult<Value>(
  input: BranchListMetricInput
): BranchMetricResult<Value> {
  return input.cohortCoverageComplete === false ? unavailable() : noData();
}
