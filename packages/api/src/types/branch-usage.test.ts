import { describe, expect, it } from "vitest";

import type { BranchUsageSummary as LegacyBranchUsageSummary } from "./branch";
import {
  aggregateBranchCostCompleteness,
  BranchCostCompleteness,
  BranchCostCompletenessReason,
  type BranchUsageSummary,
  branchCostEvidenceByteBudget,
  branchCostEvidenceFixedRowBytes,
  branchCostEvidenceRetainedBytes,
} from "./branch-usage";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "./token-cost-provenance";

describe("aggregateBranchCostCompleteness", () => {
  it("uses source-identity bytes plus the fixed allowance for retained evidence", () => {
    expect(branchCostEvidenceRetainedBytes(0)).toBe(
      branchCostEvidenceFixedRowBytes
    );
    expect(
      branchCostEvidenceRetainedBytes(
        branchCostEvidenceByteBudget - branchCostEvidenceFixedRowBytes
      )
    ).toBe(branchCostEvidenceByteBudget);
  });

  it("treats an observed empty qualifying population as complete zero", () => {
    expect(aggregateBranchCostCompleteness([])).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 0,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 },
    });
  });

  it("preserves explicit zero and both additive lanes", () => {
    expect(
      aggregateBranchCostCompleteness([
        evidence("subscription", 0, TokenCostBasis.SubscriptionEquivalent),
        evidence("api", 2, TokenCostBasis.ApiEstimated),
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 2,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 2 },
    });
  });

  it("deduplicates only identical proven identities", () => {
    const replay = evidence("same", 2, TokenCostBasis.ApiEstimated);
    expect(aggregateBranchCostCompleteness([replay, replay])).toMatchObject({
      subtotalUsd: 2,
    });
    expect(
      aggregateBranchCostCompleteness([
        replay,
        evidence("distinct", 2, TokenCostBasis.ApiEstimated),
      ])
    ).toMatchObject({ subtotalUsd: 4 });
    expect(
      aggregateBranchCostCompleteness([
        uncertainEvidence(2),
        uncertainEvidence(2),
      ])
    ).toMatchObject({ subtotalUsd: 4 });
  });

  it("deduplicates proven replays when additive lanes arrive in a different order", () => {
    const sourceIdentity = availableIdentity("same");
    const left = {
      sourceIdentity,
      costSummary: {
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd: 3,
        lanes: [
          { basis: TokenCostBasis.SubscriptionEquivalent, subtotalUsd: 1 },
          { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 2 },
        ],
      },
    };
    const right = {
      ...left,
      costSummary: {
        ...left.costSummary,
        lanes: [...left.costSummary.lanes].reverse(),
      },
    };
    expect(aggregateBranchCostCompleteness([left, right])).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
  });

  it("excludes conflicting identity groups independent of input order", () => {
    const left = evidence("same", 1, TokenCostBasis.ApiEstimated);
    const right = evidence("same", 2, TokenCostBasis.ApiEstimated);
    const other = evidence("other", 0, TokenCostBasis.SubscriptionEquivalent);
    const expected = {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.ConflictingSourceIdentity,
      subtotalUsd: 0,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 },
    };
    expect(aggregateBranchCostCompleteness([left, right, other])).toEqual(
      expected
    );
    expect(aggregateBranchCostCompleteness([other, right, left])).toEqual(
      expected
    );
  });

  it("keeps valid fallback cost partial for malformed, legacy, and unsupported evidence", () => {
    expect(
      aggregateBranchCostCompleteness([
        { sourceIdentity: { bad: true }, fallbackSubtotalUsd: 0 },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 0,
    });
    expect(
      aggregateBranchCostCompleteness([uncertainEvidence(3)])
    ).toMatchObject({ reason: BranchCostCompletenessReason.LegacyRecord });
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Unavailable,
            reason: TokenSourceIdentityUnavailableReason.UnsupportedSource,
          },
        },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.UnsupportedSource,
    });
  });

  it("omits lanes and marks classification incomplete when any subtotal lacks lanes", () => {
    expect(
      aggregateBranchCostCompleteness([
        evidence("classified", 1, TokenCostBasis.ApiEstimated),
        {
          sourceIdentity: availableIdentity("unclassified"),
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 2,
          },
        },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.ClassificationIncomplete,
      subtotalUsd: 3,
    });
  });

  it("uses the fixed reason precedence", () => {
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: { bad: true },
          fallbackSubtotalUsd: 1,
          coverageIncomplete: true,
        },
      ])
    ).toMatchObject({ reason: BranchCostCompletenessReason.Malformed });
  });

  it("degrades unknown forward discriminants without calling them malformed", () => {
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: { availability: "future_identity" },
          costSummary: { completeness: "future_summary" },
        },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Unknown,
    });
  });

  it("degrades forward nested values and additive fields as unknown", () => {
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Unavailable,
            reason: "future_reason",
          },
        },
        {
          sourceIdentity: {
            ...availableIdentity("future-field"),
            futureField: true,
          },
        },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Unknown,
    });
  });

  it("keeps known-version identity and lane constraint failures malformed", () => {
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Available,
            scheme: "",
            sourceRecordIds: [],
          },
        },
      ])
    ).toMatchObject({ reason: BranchCostCompletenessReason.Malformed });
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("bad-lanes"),
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 3,
            lanes: [
              { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1 },
              { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1 },
            ],
          },
        },
      ])
    ).toMatchObject({ reason: BranchCostCompletenessReason.Malformed });
  });

  it("treats a reconciled future third lane as unknown, not malformed", () => {
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("future-lane"),
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 6,
            lanes: [
              { basis: TokenCostBasis.SubscriptionEquivalent, subtotalUsd: 1 },
              { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 2 },
              { basis: "future_basis", subtotalUsd: 3 },
            ],
          },
        },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Unknown,
    });
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("bad-future-lane"),
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 7,
            lanes: [
              { basis: TokenCostBasis.SubscriptionEquivalent, subtotalUsd: 1 },
              { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 2 },
              { basis: "future_basis", subtotalUsd: 3 },
            ],
          },
        },
      ])
    ).toMatchObject({ reason: BranchCostCompletenessReason.Malformed });
  });

  it("marks missing event cost evidence as pricing incomplete", () => {
    expect(
      aggregateBranchCostCompleteness([
        evidence("priced", 1, TokenCostBasis.ApiEstimated),
        { sourceIdentity: availableIdentity("unpriced") },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.PricingIncomplete,
      subtotalUsd: 1,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 1 },
    });
    expect(
      aggregateBranchCostCompleteness([
        { sourceIdentity: availableIdentity("unpriced") },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.PricingIncomplete,
    });
  });

  it("degrades an overflowing finite aggregate without emitting invalid totals", () => {
    expect(
      aggregateBranchCostCompleteness([
        evidence("first", Number.MAX_VALUE, TokenCostBasis.ApiEstimated),
        evidence("second", Number.MAX_VALUE, TokenCostBasis.ApiEstimated),
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Malformed,
    });
  });
});

it("keeps the legacy Branch usage import assignable", () => {
  const canonical = {} as BranchUsageSummary;
  const legacy: LegacyBranchUsageSummary = canonical;
  expect(legacy).toBe(canonical);
});

function evidence(
  id: string,
  subtotalUsd: number,
  basis: (typeof TokenCostBasis)[keyof typeof TokenCostBasis]
) {
  return {
    sourceIdentity: availableIdentity(id),
    costSummary: {
      completeness: TokenCostCompleteness.Complete,
      subtotalUsd,
      lanes: [{ basis, subtotalUsd }],
    },
  };
}

function availableIdentity(id: string) {
  return {
    availability: TokenSourceIdentityAvailability.Available,
    scheme: "test",
    sourceRecordIds: [id],
  };
}

function uncertainEvidence(fallbackSubtotalUsd: number) {
  return {
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Unavailable,
      reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
    },
    fallbackSubtotalUsd,
  };
}
