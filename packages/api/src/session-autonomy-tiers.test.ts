import { describe, expect, it } from "vitest";
import {
  AUTONOMY_TIER_MIN_SCORE,
  autonomyTierRange,
  classifyAutonomyTier,
  matchesAutonomyTier,
  SESSION_AUTONOMY_TIER_FILTER_OPTIONS,
} from "./session-autonomy-tiers";

describe("classifyAutonomyTier", () => {
  it("classifies scores against the tier boundaries", () => {
    expect(classifyAutonomyTier(100)).toBe("high");
    expect(classifyAutonomyTier(AUTONOMY_TIER_MIN_SCORE.high)).toBe("high");
    expect(classifyAutonomyTier(AUTONOMY_TIER_MIN_SCORE.high - 1)).toBe(
      "mixed"
    );
    expect(classifyAutonomyTier(AUTONOMY_TIER_MIN_SCORE.mixed)).toBe("mixed");
    expect(classifyAutonomyTier(AUTONOMY_TIER_MIN_SCORE.mixed - 1)).toBe(
      "guided"
    );
    expect(classifyAutonomyTier(0)).toBe("guided");
  });

  it("treats null/undefined as unknown", () => {
    expect(classifyAutonomyTier(null)).toBe("unknown");
    expect(classifyAutonomyTier(undefined)).toBe("unknown");
  });
});

describe("matchesAutonomyTier", () => {
  it("matches only the classified tier", () => {
    expect(matchesAutonomyTier(90, "high")).toBe(true);
    expect(matchesAutonomyTier(90, "mixed")).toBe(false);
    expect(matchesAutonomyTier(null, "unknown")).toBe(true);
    expect(matchesAutonomyTier(60, "unknown")).toBe(false);
  });

  it("has an option for every tier", () => {
    expect(SESSION_AUTONOMY_TIER_FILTER_OPTIONS.map((o) => o.value)).toEqual([
      "high",
      "mixed",
      "guided",
      "unknown",
    ]);
  });
});

describe("autonomyTierRange", () => {
  it("returns adjacent half-open ranges derived from the boundaries", () => {
    expect(autonomyTierRange("high")).toEqual({
      gte: AUTONOMY_TIER_MIN_SCORE.high,
    });
    expect(autonomyTierRange("mixed")).toEqual({
      gte: AUTONOMY_TIER_MIN_SCORE.mixed,
      lt: AUTONOMY_TIER_MIN_SCORE.high,
    });
    expect(autonomyTierRange("guided")).toEqual({
      gte: AUTONOMY_TIER_MIN_SCORE.guided,
      lt: AUTONOMY_TIER_MIN_SCORE.mixed,
    });
    expect(autonomyTierRange("unknown")).toEqual({ isNull: true });
  });

  it("returns null for an unrecognized tier id", () => {
    expect(autonomyTierRange("not_a_tier")).toBeNull();
  });

  it("stays consistent with classifyAutonomyTier at each boundary", () => {
    for (const option of SESSION_AUTONOMY_TIER_FILTER_OPTIONS) {
      const range = autonomyTierRange(option.value);
      if (!range || range.isNull) {
        continue;
      }
      // A score at the inclusive lower bound classifies into this tier.
      expect(classifyAutonomyTier(range.gte)).toBe(option.value);
    }
  });
});
