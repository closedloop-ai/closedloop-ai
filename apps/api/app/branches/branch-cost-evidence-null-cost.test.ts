import type { BranchCostEvidenceContribution } from "@repo/api/src/types/branch-usage";
import { BranchCostCompletenessReason } from "@repo/api/src/types/branch-usage";
import { describe, expect, it } from "vitest";
import {
  applyCloudLifetimeCoverage,
  type CloudLifetimeSession,
} from "./branch-cost-evidence";

/**
 * ISS-7813: `validCost` had no coverage at all — this module has no direct test,
 * only one consumer, and removing its null guard left 753 tests green.
 *
 * The guard is not cosmetic. Without it `numberFromDecimal(null)` reaches
 * `null.toString()` and THROWS, so an unpriced session would take down the whole
 * branch cost-evidence projection rather than reporting itself as incomplete.
 */
function session(
  estimatedCost: CloudLifetimeSession["estimatedCost"]
): CloudLifetimeSession {
  return {
    artifactId: "a-1",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost,
    inputTokens: 10,
    outputTokens: 5,
  };
}

describe("applyCloudLifetimeCoverage with an unknown lifetime cost", () => {
  it("reports the session as pricing-incomplete rather than throwing", () => {
    const contributions: BranchCostEvidenceContribution[] = [];

    expect(() =>
      applyCloudLifetimeCoverage([session(null)], [], contributions)
    ).not.toThrow();

    expect(contributions).toHaveLength(1);
    expect(contributions[0].coverageIncomplete).toBe(true);
    // Reviewed behavior change, and a narrow one: the `Malformed` this replaces
    // was authored one commit earlier in THIS PR and never reached `main`, where
    // the case was unreachable anyway (the column was `NOT NULL`, so
    // `CloudLifetimeSession.estimatedCost` could not be null). No shipped
    // classification moves.
    //
    // It still had to change before merging. `Malformed` said a session nobody
    // priced was CORRUPT, and it is index 1 of `branchReasonPrecedence`, so it
    // would have propagated up and relabelled the whole branch's cost evidence
    // over one unpriced session — the unknown-vs-broken conflation this ticket
    // exists to remove. (What a branch-level reader actually sees here is
    // `CoverageIncomplete`, which outranks `PricingIncomplete`; the reason pinned
    // below is the contribution-level one.)
    expect(contributions[0].reason).toBe(
      BranchCostCompletenessReason.PricingIncomplete
    );
  });

  it("still reports a CORRUPT lifetime cost as malformed", () => {
    // The contrast that keeps the case above honest: unknown and broken must not
    // collapse back together in the other direction either.
    const contributions: BranchCostEvidenceContribution[] = [];
    applyCloudLifetimeCoverage([session(-1)], [], contributions);

    expect(contributions).toHaveLength(1);
    expect(contributions[0].coverageIncomplete).toBe(true);
    expect(contributions[0].reason).toBe(
      BranchCostCompletenessReason.Malformed
    );
  });

  it("does not invent a $0.00 fallback for an unknown cost", () => {
    // The distinction the nullable column exists for. Emitting 0 here would put
    // a fabricated subtotal into branch cost evidence for a session nothing
    // priced — a number a reader would take as measured.
    const contributions: BranchCostEvidenceContribution[] = [];
    applyCloudLifetimeCoverage([session(null)], [], contributions);

    expect(contributions[0].fallbackSubtotalUsd).toBeUndefined();
  });

  it("still carries a KNOWN lifetime cost as a fallback subtotal", () => {
    // The contrast case, so the test above cannot pass by the fallback simply
    // never being populated.
    const contributions: BranchCostEvidenceContribution[] = [];
    applyCloudLifetimeCoverage([session(7.5)], [], contributions);

    expect(contributions).toHaveLength(1);
    expect(contributions[0].fallbackSubtotalUsd).toBe(7.5);
  });
});
