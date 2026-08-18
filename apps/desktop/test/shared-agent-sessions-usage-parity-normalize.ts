/**
 * The comparison helper the FEA-1834 §4 usage-parity suites share.
 *
 * Split out of `shared-agent-sessions-usage-aggregation.test.ts` by ISS-4773:
 * that file is the seeded-SQLite parity SCENARIOS, this is the "how do we decide
 * two summaries are equal" contract, and the latter grew its own coverage when
 * the cost split was published. Keeping them together pushed the suite past the
 * 1,000-line ceiling, so the seam follows the responsibility rather than adding
 * a grandfather entry.
 */

import type { AgentSessionCostSplitFields } from "@repo/api/src/types/agent-session-cost-split";
import type { SharedAgentSessionUsageSummary } from "../src/shared/shared-agent-sessions-contract.js";

/**
 * Round to 9 decimals: kills the ~1 ULP difference between the two cost fold
 * orders (sum-of-per-session-costs vs cost-of-summed-tokens) while preserving
 * far more precision than the displayed cent.
 */
export const COST_EPSILON = 1e-9;

export function sortBy<T>(rows: readonly T[], select: (row: T) => string): T[] {
  return [...rows].sort((left, right) =>
    select(left).localeCompare(select(right))
  );
}

// Round to 9 decimals: kills the ~1e-15 difference between the two cost fold
// orders (sum-of-per-session-costs vs cost-of-summed-tokens) while preserving
// far more precision than the displayed cent.
export function roundCost(value: number): number {
  return Math.round(value / COST_EPSILON) * COST_EPSILON;
}

/**
 * `roundCost` for a field that is OPTIONAL on the contract. `undefined` is passed
 * through untouched: an absent split (a producer predating ISS-4773) must stay
 * distinguishable from a real `0`, so it can never be quantized into one.
 */
export function roundOptionalCost(
  value: number | undefined
): number | undefined {
  return value === undefined ? undefined : roundCost(value);
}

/**
 * Every cost-valued field on the summary contract, so `normalizeUsage` cannot
 * silently skip one.
 *
 * EVERY cost field independently needs the epsilon treatment: the two paths fold
 * the SAME per-row costs in different orders — the hydrate path sums a session's
 * rows into a per-session subtotal and adds THAT to the ledger, while the SQL
 * path adds each returned group's cost to the ledger directly — so each field is
 * separately subject to the ~1 ULP drift documented at the top of this file. That
 * bit it for real when ISS-4773 published `meteredEstimatedCost`: the collapsed
 * `apiEstimatedCost` happened to round identically on both paths, so the drift
 * only became visible once its confirmed-metered half was reported on its own
 * (0.0274425 vs 0.027442499999999998). Classification never diverged — the
 * unclassified half was byte-identical on both paths.
 *
 * Typed as `Record<keyof AgentSessionCostSplitFields, true>` so a cost field
 * ADDED to the contract fails `tsc` right here instead of surfacing later as a
 * mystery 1-ULP parity failure in CI.
 */
export const COST_SPLIT_FIELDS: Record<
  keyof AgentSessionCostSplitFields,
  true
> = {
  totalEstimatedCost: true,
  subscriptionEstimatedCost: true,
  apiEstimatedCost: true,
  meteredEstimatedCost: true,
  unknownEstimatedCost: true,
};

/**
 * Normalize a usage summary into an order- and float-noise-independent shape so
 * the two code paths can be compared with a single `deepEqual` (breakdown order
 * differs — the SQL path orders by name, the hydrate path by first appearance —
 * and that order carries no meaning).
 */
export function normalizeUsage(summary: SharedAgentSessionUsageSummary) {
  return {
    ...summary,
    totalEstimatedCost: roundCost(summary.totalEstimatedCost),
    subscriptionEstimatedCost: roundCost(summary.subscriptionEstimatedCost),
    apiEstimatedCost: roundCost(summary.apiEstimatedCost),
    // ISS-4773: the two published halves of `apiEstimatedCost` fold in the SAME
    // two orders as the collapsed bucket above, so they need the identical
    // epsilon treatment (see `COST_SPLIT_FIELDS`). Absent stays absent.
    meteredEstimatedCost: roundOptionalCost(summary.meteredEstimatedCost),
    unknownEstimatedCost: roundOptionalCost(summary.unknownEstimatedCost),
    byModel: sortBy(summary.byModel, (row) => row.model).map((row) => ({
      ...row,
      estimatedCost: roundCost(row.estimatedCost),
    })),
    byHarness: sortBy(summary.byHarness, (row) => row.harness).map((row) => ({
      ...row,
      estimatedCost: roundCost(row.estimatedCost),
    })),
  };
}
