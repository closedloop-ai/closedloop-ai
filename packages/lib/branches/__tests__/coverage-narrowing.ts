/**
 * ISS-5292 — narrowing helpers for the branch coverage/metric discriminated
 * unions, shared by the `branches/*.edges.test.ts` suites.
 *
 * `BranchPhaseAttributionCoverage` and `BranchMetricResult` both carry fields on
 * only SOME arms: `reason` is absent on `Complete` coverage, and `disclosure`
 * exists only on a `Partial` metric. A test that asserts the discriminant with
 * one `expect(...)` and then reads the arm-specific field in the next does not
 * narrow — `expect` is not a type guard — so `tsc` rejects the read.
 *
 * These helpers assert the arm and return it narrowed, so the field read is
 * type-safe AND a wrong arm fails the test with a useful message instead of
 * being silently cast away. They live under `__tests__/` because that is the
 * repo's home for test support (ISS-5463) and because the coverage aggregator's
 * `TEST_DIR_PATTERN` excludes the directory — a `.test-helpers.ts` sibling in
 * `branches/` would instead be counted as uncovered source.
 */

import {
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionCoverage,
} from "@repo/api/src/types/branch-phase-attribution";

/** Coverage arms that carry a `reason` — everything except `Complete`. */
type IncompleteCoverage = Extract<
  BranchPhaseAttributionCoverage,
  { reason: unknown }
>;

/**
 * Assert the coverage is NOT `Complete` and return it narrowed, so `.reason` is
 * readable. Throws (failing the test) when the projection returned `Complete`.
 */
export function expectIncompleteCoverage(
  coverage: BranchPhaseAttributionCoverage
): IncompleteCoverage {
  if (coverage.completeness === BranchPhaseAttributionCompleteness.Complete) {
    throw new Error(
      "expected Partial or Unavailable coverage (which carry `reason`), got Complete"
    );
  }
  return coverage;
}

/** Metric arms that carry a `disclosure` — only `Partial`. */
type PartialMetric<Value> = Extract<
  BranchMetricResult<Value>,
  { disclosure: unknown }
>;

/**
 * Assert the metric is `Partial` and return it narrowed, so `.disclosure` is
 * readable. Throws (failing the test) for any other availability state.
 */
export function expectPartialMetric<Value>(
  metric: BranchMetricResult<Value>
): PartialMetric<Value> {
  if (metric.state !== BranchMetricAvailability.Partial) {
    throw new Error(
      `expected a Partial metric (which carries \`disclosure\`), got ${metric.state}`
    );
  }
  return metric;
}
