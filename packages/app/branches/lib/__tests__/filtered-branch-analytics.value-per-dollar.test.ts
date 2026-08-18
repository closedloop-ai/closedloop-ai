import { BranchKpiState, BranchStatus } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { deriveFilteredBranchAnalytics } from "../filtered-branch-analytics";
import {
  fullCorpusBase,
  makeWireRow,
} from "./filtered-branch-analytics-fixtures";

/**
 * The Value-per-$ ratio's WINDOW STABILITY, split out of the general
 * `filtered-branch-analytics.test.ts` suite (which crossed the 1,000-line
 * ceiling) so the two axes that make the ratio window-independent live together:
 *
 * - ISS-4632 — the ratio's SPEND axis. Branch churn is a lifetime figure, so the
 *   denominator must read the lifetime per-session cost map, not the windowed one.
 * - ISS-4689 — the ratio's DIVISOR axis. The even-split must divide by each
 *   session's GLOBAL corpus branch count, not by the branches left in the visible
 *   set, or a session spanning branches of different ages still moves the ratio.
 *
 * Both degrade to the pre-fix behavior when a version-skewed server omits the
 * corresponding wire map, which is pinned here too.
 */

describe("deriveFilteredBranchAnalytics Value-per-$ window stability", () => {
  // ISS-4632 — the ratio numerator (branch churn) is LIFETIME; its denominator
  // must be lifetime spend too, or narrowing the window inflates the ratio. The
  // client reads `lifetimeSessionCostUsd` (un-windowed) for the denominator and
  // the windowed `sessionCostUsd` only for AI-spend.
  it("Value-per-$ uses the LIFETIME cost map so narrowing the window does not inflate the ratio", () => {
    const base = fullCorpusBase();
    const rows = [
      makeWireRow({
        id: "bA",
        owner: "alice",
        status: BranchStatus.Open,
        additions: 60,
        deletions: 40,
        estimatedCostUsd: 50,
        sessionIds: ["s1"],
      }),
    ];
    // Lifetime spend for s1 is $50; the WINDOWED spend (narrowed window) is only
    // $10 — most of the session's turns fell out of the window.
    const lifetimeSessionCostUsd = { s1: 50 };
    const windowedSessionCostUsd = { s1: 10 };

    const result = deriveFilteredBranchAnalytics(
      base,
      rows,
      { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
      windowedSessionCostUsd,
      lifetimeSessionCostUsd
    );

    // 100 churn / $50 LIFETIME spend = 2.0 — NOT 100/$10 = 10 (the inflated
    // ratio the windowed denominator produced before this fix).
    expect(result.locPerDollar.value).toBeCloseTo(2);
    expect(result.locPerDollar.state).toBe(BranchKpiState.Available);
    // Filtered AI spend still reflects the WINDOWED cost ($10), unchanged.
    expect(result.totalSpendUsd.value).toBeCloseTo(10);
  });

  // ISS-4632 — the ratio must be window-STABLE: the same churn over the same
  // lifetime spend yields the same ratio no matter how much windowed spend
  // shrinks, because the denominator ignores the window entirely.
  it("Value-per-$ is identical across window widths for the same lifetime spend", () => {
    const base = fullCorpusBase();
    const rows = [
      makeWireRow({
        id: "bA",
        owner: "alice",
        status: BranchStatus.Open,
        additions: 30,
        deletions: 20,
        estimatedCostUsd: 25,
        sessionIds: ["s1"],
      }),
    ];
    const lifetimeSessionCostUsd = { s1: 25 };

    const wide = deriveFilteredBranchAnalytics(
      base,
      rows,
      { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
      { s1: 25 }, // 7-day window: most spend in-window
      lifetimeSessionCostUsd
    );
    const narrow = deriveFilteredBranchAnalytics(
      base,
      rows,
      { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
      { s1: 1 }, // 1-day window: almost no spend in-window
      lifetimeSessionCostUsd
    );

    // 50 churn / $25 lifetime = 2.0 on BOTH — the ratio does not move with the
    // window; only the AI-spend headline (windowed) does.
    expect(wide.locPerDollar.value).toBeCloseTo(2);
    expect(narrow.locPerDollar.value).toBeCloseTo(2);
    expect(narrow.locPerDollar.value).toBe(wide.locPerDollar.value);
  });

  // ISS-4689 — the reviewer's worked example on the CLIENT re-derivation, which
  // always overrides the server's `locPerDollar`. The ISS-4632 cases above all
  // use a single-branch session and so cannot exhibit the divisor half of the
  // window-sensitivity.
  it("Value-per-$ is identical across window widths for a session spanning branches of different ages", () => {
    const base = fullCorpusBase();
    // s1 cost $100 and touched TWO enriched branches: bA (active today) and bB
    // (last active 60d ago), 1000 churn each.
    const branchA = makeWireRow({
      id: "bA",
      owner: "alice",
      status: BranchStatus.Open,
      additions: 600,
      deletions: 400,
      sessionIds: ["s1"],
    });
    const branchB = makeWireRow({
      id: "bB",
      owner: "alice",
      status: BranchStatus.Open,
      additions: 600,
      deletions: 400,
      sessionIds: ["s1"],
    });
    const lifetimeSessionCostUsd = { s1: 100 };
    // The GLOBAL divisor: s1 touched 2 corpus-member branches, window or not.
    const sessionBranchCount = { s1: 2 };
    const filters = { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] };

    // All-time: both branches visible → 2000 churn ÷ ($100 × 2/2) = 20.
    const allTime = deriveFilteredBranchAnalytics(
      base,
      [branchA, branchB],
      filters,
      { s1: 100 },
      lifetimeSessionCostUsd,
      sessionBranchCount
    );
    // 7-day window: bB aged out of the visible set → 1000 churn ÷ ($100 × 1/2)
    // = 20 as well. Pre-fix this divided by the IN-SET count of 1 and read 10.
    const windowed = deriveFilteredBranchAnalytics(
      base,
      [branchA],
      filters,
      { s1: 100 },
      lifetimeSessionCostUsd,
      sessionBranchCount
    );

    expect(allTime.locPerDollar.value).toBeCloseTo(20);
    expect(windowed.locPerDollar.value).toBeCloseTo(20);
    expect(windowed.locPerDollar.value).toBe(allTime.locPerDollar.value);
    expect(windowed.locPerDollar.state).toBe(BranchKpiState.Available);
  });

  // ISS-4689 — version skew: an older server omits the divisor map, so the
  // client keeps its in-set count (the pre-fix, window-sensitive ratio) rather
  // than dropping the KPI. Pinned so the regression stays visible.
  it("divides by the in-set count when the global branch-count map is absent", () => {
    const base = fullCorpusBase();
    const branchA = makeWireRow({
      id: "bA",
      owner: "alice",
      status: BranchStatus.Open,
      additions: 600,
      deletions: 400,
      sessionIds: ["s1"],
    });
    const branchB = makeWireRow({
      id: "bB",
      owner: "alice",
      status: BranchStatus.Open,
      additions: 600,
      deletions: 400,
      sessionIds: ["s1"],
    });
    const filters = { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] };

    const allTime = deriveFilteredBranchAnalytics(
      base,
      [branchA, branchB],
      filters,
      { s1: 100 },
      { s1: 100 }
      // no sessionBranchCount → in-set divisor
    );
    const windowed = deriveFilteredBranchAnalytics(
      base,
      [branchA],
      filters,
      { s1: 100 },
      { s1: 100 }
    );

    expect(allTime.locPerDollar.value).toBeCloseTo(20);
    expect(windowed.locPerDollar.value).toBeCloseTo(10);
  });

  // ISS-4632 — version skew: an older server omits the lifetime map, so the
  // client falls back to the windowed `sessionCostUsd` (pre-fix behavior) rather
  // than dropping the ratio.
  it("falls back to the windowed cost map for the ratio when the lifetime map is absent", () => {
    const base = fullCorpusBase();
    const rows = [
      makeWireRow({
        id: "bA",
        owner: "alice",
        status: BranchStatus.Open,
        additions: 60,
        deletions: 40,
        estimatedCostUsd: 20,
        sessionIds: ["s1"],
      }),
    ];

    const result = deriveFilteredBranchAnalytics(
      base,
      rows,
      { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
      { s1: 20 }
      // no lifetimeSessionCostUsd → falls back to the windowed map
    );

    // 100 churn / $20 windowed spend = 5.0 (the legacy windowed ratio).
    expect(result.locPerDollar.value).toBeCloseTo(5);
    expect(result.locPerDollar.state).toBe(BranchKpiState.Available);
  });

  // ISS-4632 — a null/unavailable-spend case must render safely: no
  // divide-by-zero, no Infinity, the KPI is Unavailable.
  it("renders Value-per-$ as Unavailable (not Infinity) when lifetime spend is zero/unpriced", () => {
    const base = fullCorpusBase();
    const rows = [
      makeWireRow({
        id: "bA",
        owner: "alice",
        status: BranchStatus.Open,
        additions: 60,
        deletions: 40,
        sessionIds: ["s1"],
      }),
    ];
    // The session is unpriced in the lifetime map (absent), so the denominator
    // is null — the churn has no spend to divide by.
    const result = deriveFilteredBranchAnalytics(
      base,
      rows,
      { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
      {},
      {}
    );

    expect(result.locPerDollar.value).toBeNull();
    expect(result.locPerDollar.state).toBe(BranchKpiState.Unavailable);
    expect(Number.isFinite(result.locPerDollar.value ?? 0)).toBe(true);
  });
});
