import {
  type BranchKpi,
  BranchKpiState,
  NO_BRANCH_KPI_BASELINE,
} from "@repo/api/src/types/branch";

/**
 * Construction of the `BranchKpi` measurements the cloud branches analytics read
 * emits. Split out of `branch-read-service.ts` so the KPI shape — including the
 * ISS-4686 baseline contract below — lives in one small module rather than
 * inside the multi-thousand-line read service.
 */

/**
 * A single analytics KPI measurement with NO 30-day comparison.
 *
 * ISS-4686: no 30-day baseline is computed here yet. Whoever wires one must
 * build it through `BranchKpiWithBaseline`, which REQUIRES a `comparisonScope`
 * — a corpus aggregate cannot silently become a per-branch verdict on the
 * branch-detail cards.
 */
export function branchKpi(
  value: number | null,
  state: BranchKpiState = value === null
    ? BranchKpiState.Unavailable
    : BranchKpiState.Available
): BranchKpi {
  return {
    value,
    state,
    ...NO_BRANCH_KPI_BASELINE,
  };
}
