/**
 * ISS-5335 (review): the story fixtures' own spend invariant.
 *
 * `Cost by model` (`chart:modelBreakdown*`) and `Spend by session outcome`
 * (`chart:spendByOutcome*`) are two GROUPINGS of one metric — both carry
 * `metricKey: "cost"` in the catalog, both sit in Agents, and the picker offers
 * them as alternate `Group by` choices on the same Cost metric. So a reader who
 * switches Group by must see the same dollars re-sliced, never a different
 * total. Nothing in the type system says so, and a fixture edit to one grouping
 * silently broke it once already, so it is pinned here.
 */

import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import type { CategoryBucket } from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import { getTile } from "../../lib/tile-catalog";
import {
  makeAgentsSections,
  spendByOutcomeFixture,
} from "../insights-section-fixtures";

const COST_BY_MODEL_TILE_ID = "chart:modelBreakdown";
const SPEND_BY_OUTCOME_TILE_ID = "chart:spendByOutcome";

/** Cents, so a redistribution that drifts by a penny still fails. */
const USD_PRECISION = 2;

function total(buckets: CategoryBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.value, 0);
}

describe("insights section fixtures", () => {
  // The premise the invariant rests on. If a future change repoints either tile
  // at a different metric, this fails first and says why the totals may diverge.
  it("keeps both spend groupings on one metric in one section", () => {
    const byModel = getTile(COST_BY_MODEL_TILE_ID);
    const byOutcome = getTile(SPEND_BY_OUTCOME_TILE_ID);

    expect(byModel).toBeDefined();
    expect(byOutcome).toBeDefined();
    expect(byOutcome?.metricKey).toBe(byModel?.metricKey);
    expect(byOutcome?.section).toBe(byModel?.section);
    expect(byOutcome?.section).toBe(InsightsSection.Agents);
  });

  it("re-slices the same dollars across both spend groupings", () => {
    const agents = makeAgentsSections(spendByOutcomeFixture)[
      InsightsSection.Agents
    ];
    const byOutcome = agents?.charts.spendByOutcome;

    expect(byOutcome).toBeDefined();
    expect(total(agents?.charts.modelBreakdown ?? [])).toBeGreaterThan(0);
    expect(total(byOutcome ?? [])).toBeCloseTo(
      total(agents?.charts.modelBreakdown ?? []),
      USD_PRECISION
    );
  });

  // The exported constant and the response builder must agree too — the picker
  // story passes the former into the latter, so a drift between them would put
  // one total in the fixture and another on screen.
  it("passes the exported outcome fixture through unchanged", () => {
    const agents = makeAgentsSections(spendByOutcomeFixture)[
      InsightsSection.Agents
    ];

    expect(agents?.charts.spendByOutcome).toEqual(spendByOutcomeFixture);
    expect(spendByOutcomeFixture.map((bucket) => bucket.key)).toContain(
      SpendOutcome.Unknown
    );
  });
});
