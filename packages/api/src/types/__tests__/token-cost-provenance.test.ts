import { describe, expect, it } from "vitest";
import {
  TOKEN_EVENT_TRANSPORT_ID_MAX_LENGTH,
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
  tokenCostSummarySchema,
  tokenEventTransportIdSchema,
  tokenSourceIdentitySchema,
} from "../token-cost-provenance.js";

const SOURCE_IDENTITY_LIMIT_PLUS_ONE = 65;

describe("token source identity", () => {
  it("preserves ordered non-empty identifiers", () => {
    const identity = {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "provider-record-v1",
      sourceRecordIds: ["record-b", "record-a"],
    };

    expect(tokenSourceIdentitySchema.parse(identity)).toEqual(identity);
  });

  it("accepts typed unavailability and rejects empty identifiers", () => {
    expect(
      tokenSourceIdentitySchema.parse({
        availability: TokenSourceIdentityAvailability.Unavailable,
        reason: TokenSourceIdentityUnavailableReason.UnsupportedSource,
      })
    ).toEqual({
      availability: TokenSourceIdentityAvailability.Unavailable,
      reason: TokenSourceIdentityUnavailableReason.UnsupportedSource,
    });
    expect(
      tokenSourceIdentitySchema.safeParse({
        availability: TokenSourceIdentityAvailability.Available,
        scheme: "provider-record-v1",
        sourceRecordIds: [""],
      }).success
    ).toBe(false);
    expect(
      tokenSourceIdentitySchema.safeParse({
        availability: TokenSourceIdentityAvailability.Available,
        scheme: "   ",
        sourceRecordIds: ["record-1"],
      }).success
    ).toBe(false);
    expect(
      tokenSourceIdentitySchema.safeParse({
        availability: "future_state",
        reason: TokenSourceIdentityUnavailableReason.Unknown,
      }).success
    ).toBe(false);
  });

  it("bounds transport and source identity evidence", () => {
    expect(tokenEventTransportIdSchema.safeParse("   ").success).toBe(false);
    expect(tokenEventTransportIdSchema.safeParse(" padded").success).toBe(
      false
    );
    expect(
      tokenEventTransportIdSchema.safeParse(
        `nul${String.fromCharCode(0)}transport`
      ).success
    ).toBe(false);
    expect(
      tokenEventTransportIdSchema.safeParse(
        `lone-high-${String.fromCharCode(0xd8_00)}`
      ).success
    ).toBe(false);
    expect(
      tokenEventTransportIdSchema.safeParse(
        `lone-low-${String.fromCharCode(0xdc_00)}`
      ).success
    ).toBe(false);
    expect(
      tokenEventTransportIdSchema.safeParse("valid-astral-identity-🚀").success
    ).toBe(true);
    expect(
      tokenEventTransportIdSchema.safeParse(
        "x".repeat(TOKEN_EVENT_TRANSPORT_ID_MAX_LENGTH + 1)
      ).success
    ).toBe(false);
    expect(
      tokenSourceIdentitySchema.safeParse({
        availability: TokenSourceIdentityAvailability.Available,
        scheme: "provider-record-v1",
        sourceRecordIds: Array.from(
          { length: SOURCE_IDENTITY_LIMIT_PLUS_ONE },
          (_, index) => `record-${index}`
        ),
      }).success
    ).toBe(false);
  });
});

describe("token cost summary", () => {
  it("preserves a real numeric zero", () => {
    expect(
      tokenCostSummarySchema.parse({
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd: 0,
        lanes: [{ basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0 }],
      })
    ).toEqual({
      completeness: TokenCostCompleteness.Complete,
      subtotalUsd: 0,
      lanes: [{ basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0 }],
    });
  });

  it("accepts typed unavailability without inventing a subtotal", () => {
    expect(
      tokenCostSummarySchema.parse({
        completeness: TokenCostCompleteness.Unavailable,
        reason: TokenCostCompletenessReason.PricingIncomplete,
      })
    ).toEqual({
      completeness: TokenCostCompleteness.Unavailable,
      reason: TokenCostCompletenessReason.PricingIncomplete,
    });
  });

  it("keeps subscription-equivalent and API-estimated lanes additive", () => {
    const summary = {
      completeness: TokenCostCompleteness.Partial,
      reason: TokenCostCompletenessReason.ClassificationIncomplete,
      subtotalUsd: 3.5,
      lanes: [
        {
          basis: TokenCostBasis.SubscriptionEquivalent,
          subtotalUsd: 2,
        },
        { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1.5 },
      ],
    };

    expect(tokenCostSummarySchema.parse(summary)).toEqual(summary);
  });

  it("rejects duplicate bases, non-additive lanes, and unavailable subtotals", () => {
    expect(
      tokenCostSummarySchema.safeParse({
        completeness: TokenCostCompleteness.Partial,
        reason: TokenCostCompletenessReason.LegacyRecord,
        subtotalUsd: 2,
        lanes: [
          { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1 },
          { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1 },
        ],
      }).success
    ).toBe(false);
    expect(
      tokenCostSummarySchema.safeParse({
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd: 2,
        lanes: [{ basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1 }],
      }).success
    ).toBe(false);
    expect(
      tokenCostSummarySchema.safeParse({
        completeness: TokenCostCompleteness.Unavailable,
        reason: TokenCostCompletenessReason.LegacyRecord,
        subtotalUsd: 0,
      }).success
    ).toBe(false);
  });
});
