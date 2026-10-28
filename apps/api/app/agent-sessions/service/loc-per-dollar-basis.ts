import { MergedLocPerDollarBasis } from "@repo/api/src/types/merged-loc-per-dollar-basis";
import type { SessionCostSplit } from "./usage-cost-split";

export const LocPerDollarBasis = {
  Total: "total",
} as const;
export type LocPerDollarBasis =
  (typeof LocPerDollarBasis)[keyof typeof LocPerDollarBasis];

export type LocPerDollarCostBasis = {
  basis: LocPerDollarBasis;
  costUsd: number;
  excludedUsd: number;
};

export function resolveLocPerDollarCostBasis(
  costSplit: SessionCostSplit
): LocPerDollarCostBasis {
  return {
    basis: LocPerDollarBasis.Total,
    costUsd: costSplit.totalEstimatedCost,
    excludedUsd: 0,
  };
}

/**
 * ISS-9848: the published basis for the divisor this module chose.
 *
 * The two vocabularies are separate on purpose and this is the ONLY bridge
 * between them. {@link LocPerDollarBasis} names which cost LEDGERS the divisor
 * sums and exists for the coverage telemetry; the wire member names the WHOLE
 * ratio a reader is looking at, numerator included, because that is what the
 * caption it drives says. Keeping them one type would make a purely server-side
 * ledger change a wire change, and vice versa.
 *
 * The map is exhaustive over {@link LocPerDollarBasis}, so adding a ledger basis
 * fails `tsc` here until the wire answer for it is decided — rather than
 * publishing the old wire member over a new denominator, which is the exact
 * collapse this field exists to prevent.
 *
 * WHAT THIS MAP DOES NOT CATCH, stated because an exhaustive map reads as proof
 * of more than it checks: it is keyed on the DENOMINATOR only. Moving the
 * NUMERATOR — ISS-9814 swaps merged lines for Pensero points behind a display
 * flag — changes nothing here, so this map would keep publishing
 * `merged_lines_over_total_cost` over a points numerator, re-creating the
 * defect inside the fix. Whoever moves the numerator owes a new
 * {@link MergedLocPerDollarBasis} member and a new key on the emit path;
 * `delivery-summary-basis.test.ts` pins today's pairing so the change cannot
 * land silently, but the compiler cannot see that axis.
 */
export function toMergedLocPerDollarBasis(
  basis: LocPerDollarBasis
): MergedLocPerDollarBasis {
  return WIRE_BASIS_BY_COST_BASIS[basis];
}

const WIRE_BASIS_BY_COST_BASIS: Record<
  LocPerDollarBasis,
  MergedLocPerDollarBasis
> = {
  [LocPerDollarBasis.Total]: MergedLocPerDollarBasis.MergedLinesOverTotalCost,
};
