import { describe, expect, it } from "vitest";
import {
  AUTONOMY_TIER_MIN_SCORE,
  autonomyTierRange,
  classifyAutonomyTier,
  getSessionCostBucket,
  matchesAutonomyTier,
  matchesChangePresence,
  matchesCostBucket,
  matchesPrAssociation,
  SESSION_AUTONOMY_TIER_FILTER_OPTIONS,
  SESSION_CHANGE_PRESENCE_OPTIONS,
  SESSION_COST_BUCKETS,
  SESSION_PR_ASSOCIATION_OPTIONS,
  sessionHasChanges,
} from "./agent-session-filters";

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

describe("matchesCostBucket", () => {
  it("uses inclusive lower / exclusive upper bounds", () => {
    expect(matchesCostBucket(0, "under_1")).toBe(true);
    expect(matchesCostBucket(0.99, "under_1")).toBe(true);
    expect(matchesCostBucket(1, "under_1")).toBe(false);
    expect(matchesCostBucket(1, "from_1_to_10")).toBe(true);
    expect(matchesCostBucket(10, "from_1_to_10")).toBe(false);
    expect(matchesCostBucket(10, "from_10_to_50")).toBe(true);
    expect(matchesCostBucket(49.99, "from_10_to_50")).toBe(true);
    expect(matchesCostBucket(50, "from_10_to_50")).toBe(false);
  });

  it("treats the top bucket as unbounded above", () => {
    expect(matchesCostBucket(50, "from_50")).toBe(true);
    expect(matchesCostBucket(10_000, "from_50")).toBe(true);
    expect(matchesCostBucket(49.99, "from_50")).toBe(false);
  });

  it("returns false for an unknown bucket id", () => {
    expect(matchesCostBucket(5, "not_a_bucket")).toBe(false);
    expect(getSessionCostBucket("not_a_bucket")).toBeUndefined();
  });

  it("covers the full non-negative cost range with no gaps", () => {
    expect(SESSION_COST_BUCKETS[0].minCost).toBe(0);
    for (let i = 1; i < SESSION_COST_BUCKETS.length; i += 1) {
      expect(SESSION_COST_BUCKETS[i].minCost).toBe(
        SESSION_COST_BUCKETS[i - 1].maxCost
      );
    }
    expect(SESSION_COST_BUCKETS.at(-1)?.maxCost).toBeNull();
  });
});

describe("sessionHasChanges", () => {
  it("is true when any diff count is greater than zero", () => {
    expect(sessionHasChanges({ filesChanged: 1 })).toBe(true);
    expect(sessionHasChanges({ linesAdded: 3 })).toBe(true);
    expect(sessionHasChanges({ linesRemoved: 2 })).toBe(true);
  });

  it("is false when every diff count is null/undefined/zero", () => {
    expect(sessionHasChanges({})).toBe(false);
    expect(
      sessionHasChanges({ filesChanged: 0, linesAdded: 0, linesRemoved: 0 })
    ).toBe(false);
    expect(
      sessionHasChanges({
        filesChanged: null,
        linesAdded: null,
        linesRemoved: null,
      })
    ).toBe(false);
  });
});

describe("matchesChangePresence", () => {
  it("maps has_changes / no_changes to the change-presence boolean", () => {
    expect(matchesChangePresence(true, "has_changes")).toBe(true);
    expect(matchesChangePresence(false, "has_changes")).toBe(false);
    expect(matchesChangePresence(false, "no_changes")).toBe(true);
    expect(matchesChangePresence(true, "no_changes")).toBe(false);
  });

  it("returns false for an unknown option id", () => {
    expect(matchesChangePresence(true, "nope")).toBe(false);
  });

  it("exposes a has/no pair", () => {
    expect(SESSION_CHANGE_PRESENCE_OPTIONS.map((o) => o.id)).toEqual([
      "has_changes",
      "no_changes",
    ]);
  });
});

describe("matchesPrAssociation", () => {
  it("maps has_pr / no_pr to the pull-request boolean", () => {
    expect(matchesPrAssociation(true, "has_pr")).toBe(true);
    expect(matchesPrAssociation(false, "has_pr")).toBe(false);
    expect(matchesPrAssociation(false, "no_pr")).toBe(true);
    expect(matchesPrAssociation(true, "no_pr")).toBe(false);
  });

  it("returns false for an unknown option id", () => {
    expect(matchesPrAssociation(true, "nope")).toBe(false);
  });

  it("exposes a has/no pair", () => {
    expect(SESSION_PR_ASSOCIATION_OPTIONS.map((o) => o.id)).toEqual([
      "has_pr",
      "no_pr",
    ]);
  });
});
