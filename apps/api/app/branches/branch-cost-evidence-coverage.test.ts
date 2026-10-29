import {
  BranchCostCompletenessReason,
  type BranchCostEvidenceContribution,
} from "@repo/api/src/types/branch-usage";
import {
  TokenCostCompleteness,
  TokenCostCompletenessReason,
} from "@repo/api/src/types/token-cost-provenance";
import { describe, expect, it } from "vitest";
import {
  applyCloudLifetimeCoverage,
  type CloudCostEvidenceEvent,
  type CloudLifetimeSession,
  toBranchCostContribution,
} from "./branch-cost-evidence";

// ISS-9713 branch coverage for the pure cost-evidence projection helpers.
// branch-cost-evidence-null-cost.test.ts already covers the lifetime-cost
// null/malformed distinction; this file targets the persisted-cost-summary
// classification tree in `toBranchCostContribution` and the remaining
// `applyCloudLifetimeCoverage` branches that suite never reaches.

function event(
  overrides: Partial<CloudCostEvidenceEvent> = {}
): CloudCostEvidenceEvent {
  return {
    agentSessionId: "session-1",
    eventCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 1.5,
    sourceIdentity: null,
    costCompleteness: null,
    costCompletenessReason: null,
    subscriptionEquivalentCost: null,
    apiEstimatedCost: null,
    ...overrides,
  };
}

describe("applyCloudLifetimeCoverage token-totals parameter", () => {
  it("uses an explicitly supplied token-totals map instead of deriving one from events", () => {
    // fallbackSubtotalUsd makes this contribution report a subtotal, so
    // hasEventSubtotal is true and the early-return path is genuinely gated
    // on tokensMatch — the branch this test targets.
    const contributions: BranchCostEvidenceContribution[] = [
      { fallbackSubtotalUsd: 1.5 },
    ];
    const events = [event({ agentSessionId: "s1", estimatedCost: 1.5 })];
    const sessions: CloudLifetimeSession[] = [
      {
        artifactId: "s1",
        estimatedCost: 1.5,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ];
    // Deliberately wrong: accumulateCloudEventTokenTotals(events) would derive
    // 15n for "s1" from the event above (which matches the session's own
    // lifetime total and would take the early-return "fully reconciled"
    // path). This explicit map instead claims 999n, forcing a mismatch the
    // derived default would not have produced — proving the parameter is used
    // rather than silently recomputed.
    const wrongTotals = new Map([["s1", 999n]]);

    applyCloudLifetimeCoverage(sessions, events, contributions, wrongTotals);

    expect(contributions[0].coverageIncomplete).toBe(true);
  });
});

describe("applyCloudLifetimeCoverage out-of-range contribution index", () => {
  it("does not throw when an event's contribution slot was never populated", () => {
    const contributions: BranchCostEvidenceContribution[] = [];
    const events = [event({ agentSessionId: "s1", estimatedCost: 1.5 })];
    const sessions: CloudLifetimeSession[] = [
      {
        artifactId: "s1",
        estimatedCost: 7,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ];

    expect(() =>
      applyCloudLifetimeCoverage(sessions, events, contributions)
    ).not.toThrow();

    // markCoverageIncomplete silently skips the missing slot rather than
    // throwing on the hole; the mismatch still surfaces via a pushed fallback.
    expect(contributions).toHaveLength(1);
    expect(contributions[0].coverageIncomplete).toBe(true);
  });
});

describe("toBranchCostContribution persisted cost-completeness classification", () => {
  it("carries a typed token reason for an Unavailable event whose reason is recognized", () => {
    const contribution = toBranchCostContribution(
      event({
        costCompleteness: TokenCostCompleteness.Unavailable,
        costCompletenessReason: TokenCostCompletenessReason.LegacyRecord,
      })
    );

    expect(contribution.costSummary).toEqual({
      completeness: TokenCostCompleteness.Unavailable,
      reason: TokenCostCompletenessReason.LegacyRecord,
    });
    expect(contribution.reason).toBeUndefined();
  });

  it("falls back to the branch-level Unknown reason for an Unavailable event with an unrecognized reason string", () => {
    const contribution = toBranchCostContribution(
      event({
        costCompleteness: TokenCostCompleteness.Unavailable,
        costCompletenessReason: "not-a-real-reason",
      })
    );

    expect(contribution.costSummary).toBeUndefined();
    expect(contribution.reason).toBe(BranchCostCompletenessReason.Unknown);
  });

  it("reports Unknown for a costCompleteness value outside complete/partial/unavailable", () => {
    const contribution = toBranchCostContribution(
      event({ costCompleteness: "bogus-completeness" })
    );

    expect(contribution.costSummary).toBeUndefined();
    expect(contribution.reason).toBe(BranchCostCompletenessReason.Unknown);
  });

  it("reports Malformed when a Complete event carries no parseable cost", () => {
    const contribution = toBranchCostContribution(
      event({
        costCompleteness: TokenCostCompleteness.Complete,
        estimatedCost: null,
      })
    );

    expect(contribution.costSummary).toBeUndefined();
    expect(contribution.reason).toBe(BranchCostCompletenessReason.Malformed);
  });

  it("omits the lanes array from a Complete summary when no subscription/api cost was recorded", () => {
    const contribution = toBranchCostContribution(
      event({
        costCompleteness: TokenCostCompleteness.Complete,
        estimatedCost: 4.2,
      })
    );

    expect(contribution.costSummary).toEqual({
      completeness: TokenCostCompleteness.Complete,
      subtotalUsd: 4.2,
    });
  });

  it("falls back to Unknown for a Partial event whose reason has no typed mapping", () => {
    const contribution = toBranchCostContribution(
      event({
        costCompleteness: TokenCostCompleteness.Partial,
        estimatedCost: 2,
        costCompletenessReason: null,
      })
    );

    expect(contribution.costSummary).toBeUndefined();
    expect(contribution.reason).toBe(BranchCostCompletenessReason.Unknown);
  });

  it("omits the lanes array from a Partial summary with a typed reason and no lane costs", () => {
    const contribution = toBranchCostContribution(
      event({
        costCompleteness: TokenCostCompleteness.Partial,
        estimatedCost: 3,
        costCompletenessReason: TokenCostCompletenessReason.PricingIncomplete,
      })
    );

    expect(contribution.costSummary).toEqual({
      completeness: TokenCostCompleteness.Partial,
      reason: TokenCostCompletenessReason.PricingIncomplete,
      subtotalUsd: 3,
    });
  });

  it("includes both cost-basis lanes on a Partial summary when subscription and api costs are both recorded", () => {
    const contribution = toBranchCostContribution(
      event({
        costCompleteness: TokenCostCompleteness.Partial,
        estimatedCost: 5,
        costCompletenessReason: TokenCostCompletenessReason.PricingIncomplete,
        subscriptionEquivalentCost: 5,
        apiEstimatedCost: 4.5,
      })
    );

    expect(
      (contribution.costSummary as { lanes?: unknown[] })?.lanes
    ).toHaveLength(2);
  });
});
