import { describe, expect, it } from "vitest";

import type { BranchUsageSummary as LegacyBranchUsageSummary } from "./branch";
import {
  aggregateBranchCostCompleteness,
  BranchCostCompleteness,
  BranchCostCompletenessReason,
  type BranchUsageSummary,
  branchCostEvidenceByteBudget,
  branchCostEvidenceFixedRowBytes,
  branchCostEvidenceHasSubtotal,
  branchCostEvidenceRetainedBytes,
  branchCostSubtotalsReconcile,
} from "./branch-usage";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
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

  it("uses a directly supplied adapter-observed reason instead of deriving pricing incompleteness", () => {
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("direct-reason"),
          reason: BranchCostCompletenessReason.ClassificationIncomplete,
        },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.ClassificationIncomplete,
    });
  });

  it("treats a missing source identity the same as an explicit null identity", () => {
    const expected = {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.SourceIdentityUnavailable,
      subtotalUsd: 5,
    };
    expect(
      aggregateBranchCostCompleteness([{ fallbackSubtotalUsd: 5 }])
    ).toEqual(expected);
    expect(
      aggregateBranchCostCompleteness([
        { sourceIdentity: null, fallbackSubtotalUsd: 5 },
      ])
    ).toEqual(expected);
  });

  it("maps every TokenCostCompletenessReason on an Unavailable cost summary to its Branch reason equivalent", () => {
    const cases: [TokenCostCompletenessReason, BranchCostCompletenessReason][] =
      [
        [
          TokenCostCompletenessReason.LegacyRecord,
          BranchCostCompletenessReason.LegacyRecord,
        ],
        [
          TokenCostCompletenessReason.UnsupportedSource,
          BranchCostCompletenessReason.UnsupportedSource,
        ],
        [
          TokenCostCompletenessReason.SourceIdentityUnavailable,
          BranchCostCompletenessReason.SourceIdentityUnavailable,
        ],
        [
          TokenCostCompletenessReason.ClassificationIncomplete,
          BranchCostCompletenessReason.ClassificationIncomplete,
        ],
        [
          TokenCostCompletenessReason.PricingIncomplete,
          BranchCostCompletenessReason.PricingIncomplete,
        ],
        [
          TokenCostCompletenessReason.Malformed,
          BranchCostCompletenessReason.Malformed,
        ],
        [
          TokenCostCompletenessReason.Unknown,
          BranchCostCompletenessReason.Unknown,
        ],
      ];
    for (const [costReason, branchReason] of cases) {
      expect(
        aggregateBranchCostCompleteness([
          {
            sourceIdentity: availableIdentity(`cost-${costReason}`),
            costSummary: {
              completeness: TokenCostCompleteness.Unavailable,
              reason: costReason,
            },
          },
        ])
      ).toEqual({
        completeness: BranchCostCompleteness.Unavailable,
        reason: branchReason,
      });
    }
  });

  it("rejects malformed fallback subtotal shapes", () => {
    const malformed = {
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Malformed,
    };
    expect(
      aggregateBranchCostCompleteness([
        { sourceIdentity: availableIdentity("s1"), fallbackSubtotalUsd: "5" },
      ])
    ).toEqual(malformed);
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("s2"),
          fallbackSubtotalUsd: Number.NaN,
        },
      ])
    ).toEqual(malformed);
    expect(
      aggregateBranchCostCompleteness([
        { sourceIdentity: availableIdentity("s3"), fallbackSubtotalUsd: -1 },
      ])
    ).toEqual(malformed);
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("s4"),
          fallbackSubtotalUsd: Number.POSITIVE_INFINITY,
        },
      ])
    ).toEqual(malformed);
  });

  it("maps every TokenSourceIdentityUnavailableReason to its Branch reason equivalent", () => {
    const cases: [
      TokenSourceIdentityUnavailableReason,
      BranchCostCompletenessReason,
    ][] = [
      [
        TokenSourceIdentityUnavailableReason.LegacyRecord,
        BranchCostCompletenessReason.LegacyRecord,
      ],
      [
        TokenSourceIdentityUnavailableReason.UnsupportedSource,
        BranchCostCompletenessReason.UnsupportedSource,
      ],
      // pins current behavior; looks odd because MissingSourceRecordId has no
      // dedicated Branch reason and silently falls back to the generic
      // SourceIdentityUnavailable bucket
      [
        TokenSourceIdentityUnavailableReason.MissingSourceRecordId,
        BranchCostCompletenessReason.SourceIdentityUnavailable,
      ],
      [
        TokenSourceIdentityUnavailableReason.Malformed,
        BranchCostCompletenessReason.Malformed,
      ],
      [
        TokenSourceIdentityUnavailableReason.Unknown,
        BranchCostCompletenessReason.Unknown,
      ],
    ];
    for (const [identityReason, branchReason] of cases) {
      expect(
        aggregateBranchCostCompleteness([
          {
            sourceIdentity: {
              availability: TokenSourceIdentityAvailability.Unavailable,
              reason: identityReason,
            },
          },
        ])
      ).toEqual({
        completeness: BranchCostCompleteness.Unavailable,
        reason: branchReason,
      });
    }
  });

  it("keys a Partial cost summary's own reason field into its evidence signature", () => {
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("partial-cost"),
          costSummary: {
            completeness: TokenCostCompleteness.Partial,
            reason: TokenCostCompletenessReason.ClassificationIncomplete,
            subtotalUsd: 4,
          },
        },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.ClassificationIncomplete,
      subtotalUsd: 4,
    });
  });

  it("treats a non-object source identity or cost summary as malformed, not forward-compatible", () => {
    const malformed = {
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Malformed,
    };
    expect(
      aggregateBranchCostCompleteness([{ sourceIdentity: "not-an-object" }])
    ).toEqual(malformed);
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("cs1"),
          costSummary: "not-an-object",
        },
      ])
    ).toEqual(malformed);
  });

  it("treats a cost summary missing its completeness discriminant as malformed", () => {
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("no-completeness"),
          costSummary: { subtotalUsd: 5 },
        },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Malformed,
    });
  });

  it("recognizes forward-compatible cost summaries carrying a known discriminant plus an unrecognized extra field as unknown, not malformed", () => {
    const unknown = {
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Unknown,
    };
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("unavailable-bad-reason"),
          costSummary: {
            completeness: TokenCostCompleteness.Unavailable,
            reason: "totally_bogus_reason",
          },
        },
      ])
    ).toEqual(unknown);
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("complete-extra-field"),
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 5,
            extraField: true,
          },
        },
      ])
    ).toEqual(unknown);
    // pins current behavior; looks odd because the embedded reason literally
    // says "malformed" yet the extra field routes the whole summary through
    // the forward-compatible path, which discards that inner reason
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("partial-known-reason-extra-field"),
          costSummary: {
            completeness: TokenCostCompleteness.Partial,
            reason: TokenCostCompletenessReason.Malformed,
            subtotalUsd: 5,
            extraField: true,
          },
        },
      ])
    ).toEqual(unknown);
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Unavailable,
            reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
            extraField: true,
          },
        },
      ])
    ).toEqual(unknown);
  });

  it("rejects forward-compatible cost summaries that still fail structural validation", () => {
    const malformed = {
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Malformed,
    };
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("partial-missing-reason"),
          costSummary: {
            completeness: TokenCostCompleteness.Partial,
            subtotalUsd: 5,
            extraField: true,
          },
        },
      ])
    ).toEqual(malformed);
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("bad-subtotal-type"),
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: "nope",
            extraField: true,
          },
        },
      ])
    ).toEqual(malformed);
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("lanes-not-array"),
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 5,
            lanes: "nope",
            extraField: true,
          },
        },
      ])
    ).toEqual(malformed);
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("lanes-mismatch"),
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 5,
            lanes: [{ basis: "custom_basis", subtotalUsd: 999 }],
            extraField: true,
          },
        },
      ])
    ).toEqual(malformed);
  });

  it("recognizes forward-compatible lanes that reconcile to the declared subtotal as unknown", () => {
    expect(
      aggregateBranchCostCompleteness([
        {
          sourceIdentity: availableIdentity("lanes-match"),
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 5,
            lanes: [{ basis: "custom_basis", subtotalUsd: 5 }],
            extraField: true,
          },
        },
      ])
    ).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Unknown,
    });
  });
});

describe("branchCostEvidenceHasSubtotal", () => {
  it("returns true when a validated cost summary carries a subtotal", () => {
    expect(
      branchCostEvidenceHasSubtotal({
        costSummary: {
          completeness: TokenCostCompleteness.Complete,
          subtotalUsd: 3,
        },
      })
    ).toBe(true);
  });

  it("returns false when a validated cost summary has no subtotal and no fallback exists", () => {
    expect(
      branchCostEvidenceHasSubtotal({
        costSummary: {
          completeness: TokenCostCompleteness.Unavailable,
          reason: TokenCostCompletenessReason.Unknown,
        },
      })
    ).toBe(false);
  });

  it("falls back to a valid fallback subtotal when the cost summary fails validation", () => {
    expect(
      branchCostEvidenceHasSubtotal({
        costSummary: { bad: true },
        fallbackSubtotalUsd: 7,
      })
    ).toBe(true);
  });

  it("accepts a zero fallback subtotal as a valid observed value", () => {
    expect(branchCostEvidenceHasSubtotal({ fallbackSubtotalUsd: 0 })).toBe(
      true
    );
  });

  it("rejects a negative, non-numeric, or missing fallback subtotal", () => {
    expect(branchCostEvidenceHasSubtotal({})).toBe(false);
    expect(branchCostEvidenceHasSubtotal({ fallbackSubtotalUsd: -1 })).toBe(
      false
    );
    expect(branchCostEvidenceHasSubtotal({ fallbackSubtotalUsd: "3" })).toBe(
      false
    );
  });
});

describe("branchCostSubtotalsReconcile", () => {
  it("treats two null subtotals as reconciled", () => {
    expect(branchCostSubtotalsReconcile(null, null)).toBe(true);
  });

  it("treats one null and one non-null subtotal as not reconciled", () => {
    expect(branchCostSubtotalsReconcile(null, 5)).toBe(false);
    expect(branchCostSubtotalsReconcile(5, null)).toBe(false);
  });

  it("reconciles subtotals within the shared float tolerance", () => {
    expect(branchCostSubtotalsReconcile(0.1 + 0.2, 0.3)).toBe(true);
  });

  it("does not reconcile subtotals outside the shared float tolerance", () => {
    expect(branchCostSubtotalsReconcile(5, 6)).toBe(false);
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
