/**
 * ISS-9848 — the published basis and the ratio it describes are ONE emission.
 *
 * WHY THIS SUITE EXISTS SEPARATELY from the producer test next door. The
 * exhaustive `Record<LocPerDollarBasis, MergedLocPerDollarBasis>` in
 * `loc-per-dollar-basis.ts` is keyed on the DENOMINATOR, so the compiler catches
 * a ledger change and nothing else. Moving the NUMERATOR — ISS-9814 swaps merged
 * lines for Pensero points behind a display flag — would leave that map happily
 * publishing `merged_lines_over_total_cost` over a quantity that is no longer
 * merged lines, which is the defect re-created inside its own fix.
 *
 * No type can see that axis, so this pins it by BEHAVIOUR: one call publishes
 * both halves, over a fixture whose ratio is only reachable from merged gross
 * lines. Change what the numerator counts and the pinned ratio moves while the
 * basis string stands still, and this suite is what says so.
 *
 * The seam is the two pure functions, not the service: `getUsageSummary` needs a
 * database mock and grades the whole composition, which is
 * `loc-per-dollar-total-cost-basis.test.ts`'s job.
 */

import type { NormalizedPr } from "@repo/api/src/insights/delivery-kpis/normalized-rows";
import { NormalizedPrState } from "@repo/api/src/insights/delivery-kpis/normalized-rows";
import { describe, expect, it } from "vitest";
import { computeDeliveryMetricsFromPrs } from "@/lib/agent-session-delivery-metrics";
import { toDeliverySummaryFields } from "./delivery-metrics";
import { LocPerDollarBasis } from "./loc-per-dollar-basis";

/** Gross lines: additions + deletions. Nothing else in the fixture sums to it. */
const ADDITIONS = 700;
const DELETIONS = 300;

/** The window's total estimated cost — the divisor `resolveLocPerDollarCostBasis` picks. */
const TOTAL_COST_USD = 250;

/**
 * Hand-computed once, here: (700 + 300) gross lines over $250 is 4 LOC/$.
 *
 * An additions-only numerator lands on 2.8 and a net-churn one on 1.6, so this
 * literal is reachable ONLY from merged GROSS lines. That is what makes the
 * basis assertion beside it a claim about the numerator and not a tautology.
 */
const EXPECTED_LOC_PER_DOLLAR = 4;

const MERGED_AT = Date.parse("2026-07-15T00:00:00.000Z");

const COST_BASIS = {
  basis: LocPerDollarBasis.Total,
  costUsd: TOTAL_COST_USD,
  excludedUsd: 0,
};

function mergedPr(): NormalizedPr {
  return {
    state: NormalizedPrState.Merged,
    createdAt: MERGED_AT,
    mergedAt: MERGED_AT,
    closedAt: null,
    additions: ADDITIONS,
    deletions: DELETIONS,
    enriched: true,
    observedAt: MERGED_AT,
  };
}

/** The production pair: compute the ratio, then project it onto the wire. */
function publish(costUsd: number | null) {
  return toDeliverySummaryFields(
    computeDeliveryMetricsFromPrs([mergedPr()], costUsd, null),
    { ...COST_BASIS, costUsd: costUsd ?? 0 }
  );
}

describe("ISS-9848 — mergedLocPerDollarBasis names the ratio actually published", () => {
  it("pairs the merged-gross-lines numerator with the basis that claims it", () => {
    const fields = publish(TOTAL_COST_USD);

    // The ratio is reachable only from gross lines over total cost...
    expect(fields.mergedLocPerDollar).toBe(EXPECTED_LOC_PER_DOLLAR);
    // ...and THIS is the sentence-driving token published beside it. Pinned as a
    // literal, not read from `MergedLocPerDollarBasis`, so a renamed wire value
    // fails here instead of being followed.
    expect(fields.mergedLocPerDollarBasis).toBe("merged_lines_over_total_cost");
  });

  it("still states the basis when the ratio itself is null", () => {
    // No cost to divide by, so the producer publishes `null` — honestly. The
    // card renders its "how" caption either way, so a basis that vanished with
    // the number would hand that caption straight back to the client's
    // compiled-in guess: the same skew defect, in a narrower window.
    const fields = publish(null);

    expect(fields.mergedLocPerDollar).toBeNull();
    expect(fields.mergedLocPerDollarBasis).toBe("merged_lines_over_total_cost");
  });

  it("never serializes the basis as null", () => {
    // Cross-repo rule: an absent optional field is OMITTED. A producer that
    // computes the metric always has a basis, so the key is present here; the
    // absence case is a producer that never calls this helper at all (the
    // desktop local fold), which cannot emit the key by construction.
    const wire = JSON.parse(JSON.stringify(publish(TOTAL_COST_USD)));

    expect(wire.mergedLocPerDollarBasis).toBe("merged_lines_over_total_cost");
    expect(Object.hasOwn(wire, "mergedLocPerDollarBasis")).toBe(true);
  });
});
