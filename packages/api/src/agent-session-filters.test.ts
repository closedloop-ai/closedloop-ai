import { describe, expect, it } from "vitest";
import {
  costBucketRawBounds,
  costFilterIncludesUnknown,
  DEFAULT_SESSION_QUALITY,
  getSessionCostBucket,
  isExhaustiveCostFilter,
  isSessionVisibleForQuality,
  isSubstantiveSession,
  matchesChangePresence,
  matchesCostBucket,
  matchesPrAssociation,
  matchesUnknownCost,
  resolveSessionQuality,
  roundDisplayedCost,
  SESSION_CHANGE_PRESENCE_OPTIONS,
  SESSION_COST_BUCKETS,
  SESSION_COST_FILTER_OPTIONS,
  SESSION_PR_ASSOCIATION_OPTIONS,
  SESSION_QUALITY_VALUES,
  SESSION_STATUS_FILTER_VALUES,
  SESSION_UNKNOWN_COST_BUCKET_ID,
  SessionChangePresenceId,
  SessionPrAssociationId,
  sessionCostIsNumeric,
  sessionHasChanges,
} from "./agent-session-filters";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "./types/session-status.ts";

describe("matchesCostBucket", () => {
  // FEA-4293 (Mike's decision): the upper bound is INCLUSIVE and the lower bound
  // is EXCLUSIVE (except the first bucket's inclusive 0), so a displayed $N.00
  // boundary value falls into the bucket whose maxCost is N — a row shown as
  // exactly $1.00 is "≤ $1", not "$1 to $10".
  it("uses exclusive lower / inclusive upper bounds", () => {
    expect(matchesCostBucket(0, "under_1")).toBe(true);
    expect(matchesCostBucket(0.99, "under_1")).toBe(true);
    // Exactly $1.00 is IN the first bucket now (≤ $1), not the second.
    expect(matchesCostBucket(1, "under_1")).toBe(true);
    expect(matchesCostBucket(1, "from_1_to_10")).toBe(false);
    // The next bucket starts just above $1.00.
    expect(matchesCostBucket(1.01, "from_1_to_10")).toBe(true);
    expect(matchesCostBucket(10, "from_1_to_10")).toBe(true);
    expect(matchesCostBucket(10, "from_10_to_50")).toBe(false);
    expect(matchesCostBucket(10.01, "from_10_to_50")).toBe(true);
    expect(matchesCostBucket(49.99, "from_10_to_50")).toBe(true);
    expect(matchesCostBucket(50, "from_10_to_50")).toBe(true);
    expect(matchesCostBucket(50, "from_50")).toBe(false);
  });

  it("treats the top bucket as unbounded above", () => {
    // $50.00 is the inclusive top of "$10 to $50", so "$50+" starts ABOVE it.
    expect(matchesCostBucket(50.01, "from_50")).toBe(true);
    expect(matchesCostBucket(10_000, "from_50")).toBe(true);
    expect(matchesCostBucket(49.99, "from_50")).toBe(false);
    expect(matchesCostBucket(50, "from_50")).toBe(false);
  });

  it("returns false for an unknown bucket id", () => {
    expect(matchesCostBucket(5, "not_a_bucket")).toBe(false);
    expect(getSessionCostBucket("not_a_bucket")).toBeUndefined();
  });

  it("labels the first bucket ≤ $1 to match the inclusive boundary", () => {
    expect(getSessionCostBucket("under_1")?.label).toBe("≤ $1");
  });

  it("covers the full non-negative cost range with no gaps", () => {
    expect(SESSION_COST_BUCKETS[0].minCost).toBe(0);
    // Adjacent buckets meet at a shared boundary value; the upper bound is
    // inclusive there and the next lower bound is exclusive, so the displayed
    // 2dp grid is partitioned with no gap and no overlap.
    for (let i = 1; i < SESSION_COST_BUCKETS.length; i += 1) {
      expect(SESSION_COST_BUCKETS[i].minCost).toBe(
        SESSION_COST_BUCKETS[i - 1].maxCost
      );
    }
    expect(SESSION_COST_BUCKETS.at(-1)?.maxCost).toBeNull();
  });

  it("routes a displayed $N.00 boundary into exactly one bucket (no overlap)", () => {
    // Each shared boundary $N.00 must match exactly one bucket: the one whose
    // inclusive maxCost is N.
    for (const value of [1, 10, 50]) {
      const matching = SESSION_COST_BUCKETS.filter((bucket) =>
        matchesCostBucket(value, bucket.id)
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].maxCost).toBe(value);
    }
  });

  // FEA-4293: the bucket boundary must agree with the DISPLAYED (2dp) figure the
  // Cost cell renders, not the raw sub-cent value.
  it("keeps a sub-dollar cost that DISPLAYS $1.00 inside the ≤ $1 cohort", () => {
    // 0.996 renders as "$1.00" in the cell; with the inclusive upper bound it
    // stays in "≤ $1" (Mike's decision) and is OUT of "$1 to $10".
    expect(matchesCostBucket(0.996, "under_1")).toBe(true);
    expect(matchesCostBucket(0.996, "from_1_to_10")).toBe(false);
    // Exactly on the display-rounding boundary (0.995 rounds to $1.00).
    expect(matchesCostBucket(0.995, "under_1")).toBe(true);
    expect(matchesCostBucket(0.995, "from_1_to_10")).toBe(false);
  });

  it("keeps a cost that DISPLAYS $0.99 inside the ≤ $1 cohort", () => {
    // 0.994 renders as "$0.99", so it stays in "≤ $1".
    expect(matchesCostBucket(0.994, "under_1")).toBe(true);
    expect(matchesCostBucket(0.994, "from_1_to_10")).toBe(false);
    expect(matchesCostBucket(0.99, "under_1")).toBe(true);
  });

  it("moves a cost that DISPLAYS $1.01 up into the $1 to $10 bucket", () => {
    // 1.006 renders as "$1.01" — above the inclusive $1.00 top of "≤ $1", so it
    // is the first value that belongs in "$1 to $10".
    expect(matchesCostBucket(1.006, "under_1")).toBe(false);
    expect(matchesCostBucket(1.006, "from_1_to_10")).toBe(true);
  });

  it("applies the same inclusive-upper boundary at every bucket edge", () => {
    // 9.996 -> "$10.00": inclusive top of "$1 to $10", NOT in "$10 to $50".
    expect(matchesCostBucket(9.996, "from_1_to_10")).toBe(true);
    expect(matchesCostBucket(9.996, "from_10_to_50")).toBe(false);
    // 49.996 -> "$50.00": inclusive top of "$10 to $50", NOT in "$50+".
    expect(matchesCostBucket(49.996, "from_10_to_50")).toBe(true);
    expect(matchesCostBucket(49.996, "from_50")).toBe(false);
  });

  // FEA-4294 codex P2: an EXACT half-cent boundary (`9.995`) — `Math.round(cost *
  // 100)` drifted here on binary-float error and left this $10.00 session in "$1
  // to $10". With the display-formatter-based rounding it displays "$10.00", the
  // inclusive top of "$1 to $10", so it stays there and is NOT in "$10 to $50".
  it("buckets an exact half-cent boundary session by its DISPLAYED value", () => {
    // 9.995 renders as "$10.00" — the inclusive top of "$1 to $10".
    expect(matchesCostBucket(9.995, "from_1_to_10")).toBe(true);
    expect(matchesCostBucket(9.995, "from_10_to_50")).toBe(false);
    // 0.995 renders as "$1.00": the inclusive top of "≤ $1".
    expect(matchesCostBucket(0.995, "under_1")).toBe(true);
    expect(matchesCostBucket(0.995, "from_1_to_10")).toBe(false);
  });
});

describe("roundDisplayedCost", () => {
  it("rounds to the 2dp the Cost cell displays", () => {
    expect(roundDisplayedCost(0.996)).toBe(1);
    expect(roundDisplayedCost(0.994)).toBe(0.99);
    expect(roundDisplayedCost(0.995)).toBe(1);
    expect(roundDisplayedCost(12.344)).toBe(12.34);
    expect(roundDisplayedCost(0)).toBe(0);
  });

  // FEA-4294 codex P2: half-cent boundaries where `Math.round(cost * 100)` drifts
  // on binary-float error (`9.995 * 100 === 999.4999999999999` → 9.99) but the
  // `Intl.NumberFormat` display renders half-away-from-zero. The rounded value
  // must equal what `formatCost` shows, at EVERY such boundary — not just the
  // ones binary float happens to get right.
  it("matches the display formatter at half-cent boundaries (no float drift)", () => {
    const displayed = (cost: number) =>
      Number(
        cost.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
          useGrouping: false,
        })
      );
    for (const cost of [0.995, 9.995, 1.005, 1.255, 49.995, 2.675, 0.125]) {
      expect(roundDisplayedCost(cost)).toBe(displayed(cost));
    }
    // The concrete case from the P2 report: displays $10.00, not $9.99.
    expect(roundDisplayedCost(9.995)).toBe(10);
  });
});

describe("costBucketRawBounds", () => {
  it("shifts the first bucket's inclusive-upper raw bound up by half a cent", () => {
    // under_1 is [0, 1] displayed → inclusive of $1.00, so the raw upper is
    // maxCost + half a cent (1.005): a raw 1.0 that displays $1.00 is IN.
    const underOne = getSessionCostBucket("under_1");
    if (!underOne) {
      throw new Error("under_1 bucket missing");
    }
    const bounds = costBucketRawBounds(underOne);
    expect(bounds.gte).toBeCloseTo(-0.005, 10);
    expect(bounds.lt).toBeCloseTo(1.005, 10);
  });

  it("shifts an interior bucket's exclusive lower up by half a cent", () => {
    // from_1_to_10 is (1, 10] displayed: lower exclusive of $1.00 → raw 1.005;
    // upper inclusive of $10.00 → raw 10.005.
    const midBucket = getSessionCostBucket("from_1_to_10");
    if (!midBucket) {
      throw new Error("from_1_to_10 bucket missing");
    }
    const bounds = costBucketRawBounds(midBucket);
    expect(bounds.gte).toBeCloseTo(1.005, 10);
    expect(bounds.lt).toBeCloseTo(10.005, 10);
  });

  it("keeps an open-ended bucket's upper bound null", () => {
    const top = getSessionCostBucket("from_50");
    if (!top) {
      throw new Error("from_50 bucket missing");
    }
    const bounds = costBucketRawBounds(top);
    expect(bounds.lt).toBeNull();
    // (50, ∞) displayed: exclusive lower of $50.00 → raw 50.005.
    expect(bounds.gte).toBeCloseTo(50.005, 10);
  });

  it("selects rows by displayed value, matching matchesCostBucket", () => {
    // A raw value in [gte, lt) on the raw column must be exactly the set
    // matchesCostBucket accepts for the same bucket — the DB twin of the
    // in-memory rounding.
    for (const bucketId of [
      "under_1",
      "from_1_to_10",
      "from_10_to_50",
      "from_50",
    ]) {
      const bucket = getSessionCostBucket(bucketId);
      if (!bucket) {
        throw new Error(`${bucketId} bucket missing`);
      }
      const { gte, lt } = costBucketRawBounds(bucket);
      for (const raw of [
        0, 0.5, 0.994, 0.995, 0.996, 1, 1.006, 9.996, 10, 10.006, 49.996, 50,
        50.006,
      ]) {
        const inRawBounds = raw >= gte && (lt === null || raw < lt);
        expect(inRawBounds).toBe(matchesCostBucket(raw, bucketId));
      }
    }
  });
});

describe("sessionCostIsNumeric (FEA-4294 / ISS-4481)", () => {
  it("treats a priced cost as numeric", () => {
    expect(sessionCostIsNumeric({ estimatedCost: 0.5 })).toBe(true);
    expect(sessionCostIsNumeric({ estimatedCost: 12.34 })).toBe(true);
  });

  it("treats an unknown/blank cost (renders — ) as NOT numeric", () => {
    // estimatedCost 0 with no subscription = the "—" cell; must be excluded from
    // numeric buckets so it never satisfies "< $1".
    expect(sessionCostIsNumeric({ estimatedCost: 0 })).toBe(false);
    expect(sessionCostIsNumeric({ estimatedCost: 0, billingMode: null })).toBe(
      false
    );
    expect(sessionCostIsNumeric({ estimatedCost: 0, billingMode: "api" })).toBe(
      false
    );
  });

  it("treats a WORKED $0 subscription session (shows a $ figure) as numeric", () => {
    // ISS-4481: a subscription session is only numeric if it did measurable work
    // — `deriveCostAvailability` renders the $ figure for Subscription, but only
    // AFTER the measurable-work gate. Any substantive signal (a turn here) proves
    // work.
    expect(
      sessionCostIsNumeric({
        estimatedCost: 0,
        billingMode: "max_20x",
        turns: 3,
      })
    ).toBe(true);
    expect(
      sessionCostIsNumeric({
        estimatedCost: 0,
        billingMode: "pro",
        outputTokens: 120,
      })
    ).toBe(true);
  });

  it("treats a NO-WORK $0 subscription session (renders — ) as NOT numeric", () => {
    // ISS-4418/ISS-4481: a subscription session that never ran (no turns/tokens/
    // tool-uses, $0) renders "—", not "$0.00" — so it is Unknown, not numeric,
    // exactly like `deriveCostAvailability`'s no-work branch. This is the case the
    // codex P2 / stage threads flagged: the old predicate wrongly called it
    // numeric and hid it from the Unknown facet.
    expect(
      sessionCostIsNumeric({ estimatedCost: 0, billingMode: "max_20x" })
    ).toBe(false);
    expect(
      sessionCostIsNumeric({
        estimatedCost: 0,
        billingMode: "pro",
        turns: 0,
        toolUseCount: 0,
      })
    ).toBe(false);
  });
});

describe("matchesUnknownCost (ISS-4481)", () => {
  it("matches exactly the rows that render — : non-subscription, non-positive cost", () => {
    expect(matchesUnknownCost({ estimatedCost: 0 })).toBe(true);
    expect(matchesUnknownCost({ estimatedCost: 0, billingMode: null })).toBe(
      true
    );
    expect(matchesUnknownCost({ estimatedCost: 0, billingMode: "api" })).toBe(
      true
    );
  });

  it("does NOT match a priced session (renders a $ figure)", () => {
    expect(matchesUnknownCost({ estimatedCost: 0.5 })).toBe(false);
    expect(matchesUnknownCost({ estimatedCost: 12.34 })).toBe(false);
  });

  it("does NOT match a WORKED $0 subscription session (still shows a $ figure)", () => {
    expect(
      matchesUnknownCost({ estimatedCost: 0, billingMode: "max_20x", turns: 3 })
    ).toBe(false);
    expect(
      matchesUnknownCost({
        estimatedCost: 0,
        billingMode: "pro",
        outputTokens: 120,
      })
    ).toBe(false);
  });

  it("MATCHES a NO-WORK $0 subscription session (renders — , codex P2 gap)", () => {
    // The core ISS-4481 regression: a no-work subscription session renders "—", so
    // the Unknown facet must include it — the old predicate excluded it.
    expect(
      matchesUnknownCost({ estimatedCost: 0, billingMode: "max_20x" })
    ).toBe(true);
    expect(
      matchesUnknownCost({ estimatedCost: 0, billingMode: "pro", turns: 0 })
    ).toBe(true);
  });

  it("is the exact complement of sessionCostIsNumeric for every case", () => {
    const cases = [
      { estimatedCost: 0 },
      { estimatedCost: 0, billingMode: null },
      { estimatedCost: 0, billingMode: "api" },
      { estimatedCost: 0, billingMode: "max_20x" },
      { estimatedCost: 0, billingMode: "max_20x", turns: 5 },
      { estimatedCost: 0.5 },
      { estimatedCost: 99, billingMode: "pro" },
    ];
    for (const signals of cases) {
      expect(matchesUnknownCost(signals)).toBe(!sessionCostIsNumeric(signals));
    }
  });
});

describe("isExhaustiveCostFilter (ISS-4481 shafty thread)", () => {
  const everyId = SESSION_COST_FILTER_OPTIONS.map((option) => option.id);

  it("is true when every numeric bucket AND Unknown are selected", () => {
    expect(isExhaustiveCostFilter(everyId)).toBe(true);
    // Order-independent and duplicate-tolerant.
    expect(isExhaustiveCostFilter([...everyId, ...everyId, "junk"])).toBe(true);
  });

  it("is false when any option is missing", () => {
    expect(isExhaustiveCostFilter(everyId.slice(1))).toBe(false);
    expect(
      isExhaustiveCostFilter(
        SESSION_COST_BUCKETS.map((bucket) => bucket.id) // numeric only, no Unknown
      )
    ).toBe(false);
    expect(isExhaustiveCostFilter([SESSION_UNKNOWN_COST_BUCKET_ID])).toBe(
      false
    );
  });

  it("is false for empty or absent selections", () => {
    expect(isExhaustiveCostFilter([])).toBe(false);
    expect(isExhaustiveCostFilter(undefined)).toBe(false);
  });
});

describe("costFilterIncludesUnknown (ISS-4481)", () => {
  it("is true only when the Unknown id is present", () => {
    expect(costFilterIncludesUnknown([SESSION_UNKNOWN_COST_BUCKET_ID])).toBe(
      true
    );
    expect(
      costFilterIncludesUnknown(["under_1", SESSION_UNKNOWN_COST_BUCKET_ID])
    ).toBe(true);
  });

  it("is false for numeric-only, empty, or absent arrays", () => {
    expect(costFilterIncludesUnknown(["under_1", "from_50"])).toBe(false);
    expect(costFilterIncludesUnknown([])).toBe(false);
    expect(costFilterIncludesUnknown(undefined)).toBe(false);
  });
});

describe("SESSION_COST_FILTER_OPTIONS (ISS-4481)", () => {
  it("equals the numeric buckets plus a trailing Unknown option (== displayed cost states)", () => {
    // The option set must cover every displayed cost state: a $ figure lands in
    // one numeric bucket, a "—" row is Unknown. No rendered state is unselectable.
    expect(SESSION_COST_FILTER_OPTIONS.map((option) => option.id)).toEqual([
      ...SESSION_COST_BUCKETS.map((bucket) => bucket.id),
      SESSION_UNKNOWN_COST_BUCKET_ID,
    ]);
  });

  it("labels the Unknown option 'Unknown'", () => {
    const unknown = SESSION_COST_FILTER_OPTIONS.at(-1);
    expect(unknown?.id).toBe(SESSION_UNKNOWN_COST_BUCKET_ID);
    expect(unknown?.label).toBe("Unknown");
  });

  it("does NOT leak the Unknown id into the numeric-bucket lookup", () => {
    // The Unknown id is not a numeric bucket, so getSessionCostBucket ignores it —
    // matchesCostBucket / costBucketRawBounds never reason about it.
    expect(
      getSessionCostBucket(SESSION_UNKNOWN_COST_BUCKET_ID)
    ).toBeUndefined();
    expect(matchesCostBucket(0, SESSION_UNKNOWN_COST_BUCKET_ID)).toBe(false);
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
    expect(
      matchesChangePresence(true, SessionChangePresenceId.HasChanges)
    ).toBe(true);
    expect(
      matchesChangePresence(false, SessionChangePresenceId.HasChanges)
    ).toBe(false);
    expect(
      matchesChangePresence(false, SessionChangePresenceId.NoChanges)
    ).toBe(true);
    expect(matchesChangePresence(true, SessionChangePresenceId.NoChanges)).toBe(
      false
    );
  });

  it("returns false for an unknown option id", () => {
    expect(matchesChangePresence(true, "nope")).toBe(false);
  });

  it("wires the options list to the canonical ids (SSOT, ISS-4548)", () => {
    // The options derive from SessionChangePresenceId, so the matcher and the
    // cloud where-builder move with any id rename instead of drifting a literal.
    expect(SESSION_CHANGE_PRESENCE_OPTIONS.map((o) => o.id)).toEqual([
      SessionChangePresenceId.HasChanges,
      SessionChangePresenceId.NoChanges,
    ]);
  });

  it("pins the wire values old desktop clients still send", () => {
    expect([
      SessionChangePresenceId.HasChanges,
      SessionChangePresenceId.NoChanges,
    ]).toEqual(["has_changes", "no_changes"]);
  });
});

describe("matchesPrAssociation", () => {
  it("maps has_pr / no_pr to the pull-request boolean", () => {
    expect(matchesPrAssociation(true, SessionPrAssociationId.HasPr)).toBe(true);
    expect(matchesPrAssociation(false, SessionPrAssociationId.HasPr)).toBe(
      false
    );
    expect(matchesPrAssociation(false, SessionPrAssociationId.NoPr)).toBe(true);
    expect(matchesPrAssociation(true, SessionPrAssociationId.NoPr)).toBe(false);
  });

  it("returns false for an unknown option id", () => {
    expect(matchesPrAssociation(true, "nope")).toBe(false);
  });

  it("wires the options list to the canonical ids (SSOT, ISS-4548)", () => {
    expect(SESSION_PR_ASSOCIATION_OPTIONS.map((o) => o.id)).toEqual([
      SessionPrAssociationId.HasPr,
      SessionPrAssociationId.NoPr,
    ]);
  });

  it("pins the wire values old desktop clients still send", () => {
    expect([SessionPrAssociationId.HasPr, SessionPrAssociationId.NoPr]).toEqual(
      ["has_pr", "no_pr"]
    );
  });
});

describe("isSubstantiveSession (FEA-3284)", () => {
  it("classifies a 0-turn / 0-token / 0-tool session as idle", () => {
    expect(
      isSubstantiveSession({
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolUseCount: 0,
      })
    ).toBe(false);
  });

  it("treats an all-null (pre-backfill / event-less) session as idle", () => {
    expect(isSubstantiveSession({})).toBe(false);
    expect(
      isSubstantiveSession({
        turns: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        toolUseCount: null,
      })
    ).toBe(false);
  });

  it("is substantive with at least one turn", () => {
    expect(isSubstantiveSession({ turns: 1 })).toBe(true);
  });

  it("is substantive on tokens only (each token kind counts)", () => {
    expect(isSubstantiveSession({ inputTokens: 1 })).toBe(true);
    expect(isSubstantiveSession({ outputTokens: 1 })).toBe(true);
    expect(isSubstantiveSession({ cacheReadTokens: 1 })).toBe(true);
    expect(isSubstantiveSession({ cacheWriteTokens: 1 })).toBe(true);
  });

  it("is substantive on tool-use only", () => {
    expect(isSubstantiveSession({ toolUseCount: 1 })).toBe(true);
  });

  it("does not count negative sentinel values as substantive", () => {
    expect(
      isSubstantiveSession({ turns: -1, inputTokens: -5, toolUseCount: -1 })
    ).toBe(false);
  });

  it("pins the quality contract vocabulary + defaults", () => {
    // FEA-4145: the segment added `idle` between `substantive` and `all`.
    expect(SESSION_QUALITY_VALUES).toEqual(["substantive", "idle", "all"]);
    // FEA-3345 tripwire: the absent-param default MUST stay fail-open (`all`) so
    // ungated surfaces (dashboards/insights/feeds) show every session. Do NOT
    // change without revisiting FEA-3345.
    expect(DEFAULT_SESSION_QUALITY).toBe("all");
  });

  it("resolveSessionQuality is fail-open: absent resolves to the default, explicit passes through", () => {
    // The single resolver both web seams share (FEA-3345): absent/nullish ⇒ the
    // fail-open default; an explicit value is honored verbatim.
    expect(resolveSessionQuality(undefined)).toBe("all");
    expect(resolveSessionQuality(null)).toBe("all");
    expect(resolveSessionQuality("substantive")).toBe("substantive");
    expect(resolveSessionQuality("idle")).toBe("idle");
    expect(resolveSessionQuality("all")).toBe("all");
  });
});

describe("isSessionVisibleForQuality (FEA-4145)", () => {
  it("substantive shows only substantive sessions", () => {
    expect(isSessionVisibleForQuality(true, "substantive")).toBe(true);
    expect(isSessionVisibleForQuality(false, "substantive")).toBe(false);
  });

  it("idle shows only idle (non-substantive) sessions", () => {
    expect(isSessionVisibleForQuality(false, "idle")).toBe(true);
    expect(isSessionVisibleForQuality(true, "idle")).toBe(false);
  });

  it("all shows both substantive and idle sessions", () => {
    expect(isSessionVisibleForQuality(true, "all")).toBe(true);
    expect(isSessionVisibleForQuality(false, "all")).toBe(true);
  });
});

describe("SESSION_STATUS_FILTER_VALUES (ISS-4586 / ISS-4858)", () => {
  it("offers the canonical Active/Waiting/Inactive/Error/Stale/Unknown vocabulary in facet order", () => {
    // ISS-5366 appended `stale` and `unknown`. They are here for the same
    // reason `waiting` is: the SERVER projects them
    // (`projectDisplayedSessionStatus` applies the display staleness cutoff and
    // the unrecognized-status fold), so the Status column badges them for every
    // user and both have real predicates in `buildStatusFacetPredicate`. A
    // vocabulary without them left a value on screen that no filter could
    // gather. Appended rather than inserted so the pre-existing lifecycle order
    // is untouched.
    expect(SESSION_STATUS_FILTER_VALUES).toEqual([
      SESSION_STATUS.ACTIVE,
      DISPLAYED_SESSION_STATUS.WAITING,
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ERROR,
      DISPLAYED_SESSION_STATUS.STALE,
      DISPLAYED_SESSION_STATUS.UNKNOWN,
    ]);
  });

  it("never offers the retired completed/abandoned values", () => {
    // ISS-4586 collapsed both into `inactive`, so neither is offered here.
    //
    // ISS-4985: a surface that still advertises them no longer sends a filter
    // that falls through to an exact `artifact.status` match reaching only
    // not-yet-migrated legacy rows (the pre-ISS-4985 behavior, ISS-4858) — such
    // a value now folds onto the Inactive predicate that absorbed it. Keeping
    // them out of the advertised set is still the contract: the fold is inbound
    // TOLERANCE for a version-skewed caller, not permission to offer a retired
    // word in the facet.
    expect(SESSION_STATUS_FILTER_VALUES).not.toContain("completed");
    expect(SESSION_STATUS_FILTER_VALUES).not.toContain("abandoned");
  });
});
