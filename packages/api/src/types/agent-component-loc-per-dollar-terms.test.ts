/**
 * ISS-9097 (tamsinb, #7881) — the component LOC/$ terms are a SPLIT of the
 * sentence `AgentComponentRow.locPerDollar` is documented with, not new copy.
 *
 * The guarantee its comment claims had no test behind it: nothing in the repo
 * referenced `COMPONENT_LOC_PER_DOLLAR_*` except the registry that consumes it,
 * so either half could be reworded into words no human approved and stay green.
 *
 * The expected sentence is written out rather than read back from the constants
 * — an expectation assembled from the module under test agrees with whatever
 * that module later says, which is the one regression this file exists to catch.
 */
import { describe, expect, it } from "vitest";
import {
  COMPONENT_LOC_PER_DOLLAR_DENOMINATOR,
  COMPONENT_LOC_PER_DOLLAR_NUMERATOR,
  COMPONENT_LOC_PER_DOLLAR_POPULATION,
} from "./agent-component";

/** The ISS-4667 sentence on `AgentComponentRow.locPerDollar`, verbatim. */
const DOCUMENTED_RATIO =
  "lines changed per dollar across the sessions that used this component";

describe("the component LOC/$ terms", () => {
  it("reassembles into the documented sentence", () => {
    expect(
      `${COMPONENT_LOC_PER_DOLLAR_NUMERATOR} per dollar across ${COMPONENT_LOC_PER_DOLLAR_POPULATION}`
    ).toBe(DOCUMENTED_RATIO);
  });

  /**
   * The denominator is NOT a split of that sentence — "per dollar" names a unit
   * and no divisor — so what is pinned instead is that it measures the SAME
   * population the numerator is summed over. A denominator that drifts to a
   * different cohort is the mis-filing this registry exists to end, and it is
   * the half no reassembly can catch.
   */
  it("divides over the same population it sums", () => {
    expect(COMPONENT_LOC_PER_DOLLAR_DENOMINATOR).toBe(
      `estimated cost across ${COMPONENT_LOC_PER_DOLLAR_POPULATION}`
    );
  });

  /**
   * `apps/api/app/agent-components/loc-per-dollar.ts` has no merge predicate
   * anywhere — it sums every session that used the component — so no term here
   * may claim one. `agents-table.tsx` and `detail-data.ts` carry the same
   * ISS-5366 refusal at the render sites.
   */
  it("claims no merge gate on any term", () => {
    for (const term of [
      COMPONENT_LOC_PER_DOLLAR_NUMERATOR,
      COMPONENT_LOC_PER_DOLLAR_DENOMINATOR,
      COMPONENT_LOC_PER_DOLLAR_POPULATION,
    ]) {
      expect(term).not.toContain("merged");
    }
  });
});
