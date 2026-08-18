import { describe, expect, it } from "vitest";
import {
  type EvenSplitBranch,
  isLocEnriched,
  sumEvenSplitEnrichedSpend,
} from "./loc-per-dollar";

describe("isLocEnriched", () => {
  it("requires BOTH line counts (AND, not OR)", () => {
    expect(isLocEnriched({ additions: 10, deletions: 5 })).toBe(true);
    // KNOWN-zero LOC is enriched; UNKNOWN (either null) is not.
    expect(isLocEnriched({ additions: 0, deletions: 0 })).toBe(true);
    expect(isLocEnriched({ additions: 10, deletions: null })).toBe(false);
    expect(isLocEnriched({ additions: null, deletions: 5 })).toBe(false);
    expect(isLocEnriched({ additions: null, deletions: null })).toBe(false);
  });
});

describe("sumEvenSplitEnrichedSpend", () => {
  it("returns the full cost when a session touches one enriched branch", () => {
    const branches: EvenSplitBranch[] = [
      { enriched: true, sessionIds: ["s1"] },
    ];
    expect(sumEvenSplitEnrichedSpend(branches, new Map([["s1", 0.5]]))).toBe(
      0.5
    );
  });

  it("keeps only the enriched share of a session split across enriched + un-enriched branches", () => {
    // s1 touched an enriched and an un-enriched branch: its $1.00 even-splits to
    // $0.50 each, and only the enriched half enters the denominator.
    const branches: EvenSplitBranch[] = [
      { enriched: true, sessionIds: ["s1"] },
      { enriched: false, sessionIds: ["s1"] },
    ];
    expect(sumEvenSplitEnrichedSpend(branches, new Map([["s1", 1]]))).toBe(0.5);
  });

  it("apportions across three branches (2 enriched, 1 un-enriched) as 2/3", () => {
    const branches: EvenSplitBranch[] = [
      { enriched: true, sessionIds: ["s1"] },
      { enriched: true, sessionIds: ["s1"] },
      { enriched: false, sessionIds: ["s1"] },
    ];
    expect(sumEvenSplitEnrichedSpend(branches, new Map([["s1", 3]]))).toBe(2);
  });

  it("counts a 0-cost enriched session as priced-zero (0, not null)", () => {
    const branches: EvenSplitBranch[] = [
      { enriched: true, sessionIds: ["s1"] },
    ];
    expect(sumEvenSplitEnrichedSpend(branches, new Map([["s1", 0]]))).toBe(0);
  });

  it("returns null when no enriched branch carries a priced session", () => {
    // Session cost present, but the only branch it touched is un-enriched.
    const branches: EvenSplitBranch[] = [
      { enriched: false, sessionIds: ["s1"] },
    ];
    expect(
      sumEvenSplitEnrichedSpend(branches, new Map([["s1", 1]]))
    ).toBeNull();
    // A priced session absent from every branch (no link) contributes nothing.
    expect(
      sumEvenSplitEnrichedSpend(
        [{ enriched: true, sessionIds: ["s1"] }],
        new Map([["orphan", 1]])
      )
    ).toBeNull();
    // Empty inputs.
    expect(sumEvenSplitEnrichedSpend([], new Map())).toBeNull();
  });

  // ISS-4689 — the reviewer's worked example from PR #4120. Every case here uses
  // a MULTI-BRANCH shared session (`sessionIds: ["s1"]` on two rows); the older
  // fixtures above are single-row and structurally cannot exhibit the bug.
  describe("global (window-independent) divisor", () => {
    // The whole point: the SAME session must contribute the same $-per-churn no
    // matter how many of its branches survive the date window.
    it("keeps the ratio identical when a branch drops out of the window", () => {
      // s1 costs $100 and touched TWO enriched branches — A (active today,
      // 1000 churn) and B (last active 60d ago, 1000 churn).
      const globalBranchCounts = new Map([["s1", 2]]);
      const cost = new Map([["s1", 100]]);

      // All-time: both branches in the set. $100 × 2/2 = $100 over 2000 churn.
      const allTime = sumEvenSplitEnrichedSpend(
        [
          { enriched: true, sessionIds: ["s1"] },
          { enriched: true, sessionIds: ["s1"] },
        ],
        cost,
        globalBranchCounts
      );
      // 7-day window: only branch A is in the set. $100 × 1/2 = $50 over the 1000
      // churn that came with it — NOT the pre-fix $100 × 1/1 = $100.
      const windowed = sumEvenSplitEnrichedSpend(
        [{ enriched: true, sessionIds: ["s1"] }],
        cost,
        globalBranchCounts
      );

      expect(allTime).toBeCloseTo(100, 10);
      expect(windowed).toBeCloseTo(50, 10);
      // The ratio — the number the card actually renders — is 20 on both.
      expect(2000 / (allTime ?? 1)).toBeCloseTo(20, 10);
      expect(1000 / (windowed ?? 1)).toBeCloseTo(20, 10);
    });

    // The pre-fix behavior, pinned so the regression is visible: without the
    // global map the same narrowing halves the ratio (20 → 10).
    it("still moves with the window when no global divisor is supplied", () => {
      const cost = new Map([["s1", 100]]);
      const allTime = sumEvenSplitEnrichedSpend(
        [
          { enriched: true, sessionIds: ["s1"] },
          { enriched: true, sessionIds: ["s1"] },
        ],
        cost
      );
      const windowed = sumEvenSplitEnrichedSpend(
        [{ enriched: true, sessionIds: ["s1"] }],
        cost
      );

      expect(2000 / (allTime ?? 1)).toBeCloseTo(20, 10);
      expect(1000 / (windowed ?? 1)).toBeCloseTo(10, 10);
    });

    // Enrichment still gates the numerator: the global divisor changes WHAT the
    // cost is divided by, never which branches count as enriched.
    it("keeps only the in-set ENRICHED share over the global divisor", () => {
      // s1 touched 4 branches org-wide; the supplied set holds 2 of them, one
      // enriched and one not. Only the enriched one earns a share: $100 × 1/4.
      expect(
        sumEvenSplitEnrichedSpend(
          [
            { enriched: true, sessionIds: ["s1"] },
            { enriched: false, sessionIds: ["s1"] },
          ],
          new Map([["s1", 100]]),
          new Map([["s1", 4]])
        )
      ).toBeCloseTo(25, 10);
    });

    // Per-session, not global-global: two sessions with different branch counts
    // each divide by their own.
    it("applies each session's own global count", () => {
      const total = sumEvenSplitEnrichedSpend(
        [{ enriched: true, sessionIds: ["s1", "s2"] }],
        new Map([
          ["s1", 100],
          ["s2", 100],
        ]),
        new Map([
          ["s1", 4],
          ["s2", 2],
        ])
      );
      // $100/4 + $100/2 = $75.
      expect(total).toBeCloseTo(75, 10);
    });

    // A session the producer could not supply a count for must not silently
    // divide by something else — it keeps the in-set count.
    it("falls back to the in-set count for a session missing from the map", () => {
      expect(
        sumEvenSplitEnrichedSpend(
          [
            { enriched: true, sessionIds: ["s1"] },
            { enriched: true, sessionIds: ["s1"] },
          ],
          new Map([["s1", 100]]),
          new Map([["other", 5]])
        )
      ).toBeCloseTo(100, 10);
    });

    // The divisor arrives over JSON (`BranchListResponse.sessionBranchCount`), so
    // a stale or corrupt value is reachable at runtime. It must never divide by
    // LESS than the branches actually in the set — that would attribute more than
    // 100% of the session's cost — and never by a non-finite value.
    it("clamps a stale, zero, negative, or non-finite global count to the in-set count", () => {
      const branches: EvenSplitBranch[] = [
        { enriched: true, sessionIds: ["s1"] },
        { enriched: true, sessionIds: ["s1"] },
      ];
      const cost = new Map([["s1", 100]]);
      for (const bogus of [1, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          sumEvenSplitEnrichedSpend(branches, cost, new Map([["s1", bogus]]))
        ).toBeCloseTo(100, 10);
      }
    });

    // A branch count is a cardinality, so a fractional wire value is malformed on
    // its face. Taking it would divide $100 of spend by 2.5 and render a
    // plausible-but-wrong ratio; the in-set count of 2 must stand instead.
    it("rejects a fractional or unsafe-integer global count above the in-set count", () => {
      const branches: EvenSplitBranch[] = [
        { enriched: true, sessionIds: ["s1"] },
        { enriched: true, sessionIds: ["s1"] },
      ];
      const cost = new Map([["s1", 100]]);
      for (const malformed of [2.5, 3.0001, Number.MAX_SAFE_INTEGER + 2]) {
        expect(
          sumEvenSplitEnrichedSpend(
            branches,
            cost,
            new Map([["s1", malformed]])
          )
        ).toBeCloseTo(100, 10);
      }
    });
  });

  it("sums independent sessions across their own enriched shares", () => {
    // s1: one enriched branch → full $1. s2: split enriched/un-enriched → $0.50.
    const branches: EvenSplitBranch[] = [
      { enriched: true, sessionIds: ["s1", "s2"] },
      { enriched: false, sessionIds: ["s2"] },
    ];
    expect(
      sumEvenSplitEnrichedSpend(
        branches,
        new Map([
          ["s1", 1],
          ["s2", 1],
        ])
      )
    ).toBeCloseTo(1.5, 10);
  });
});
