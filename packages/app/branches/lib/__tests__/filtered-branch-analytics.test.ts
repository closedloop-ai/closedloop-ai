import {
  BranchKpiState,
  BranchSessionPresence,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { projectCanonicalBranchListMetrics } from "@repo/lib/branches/branch-list-metric-projection";
import { describe, expect, it } from "vitest";
import type { BranchRow as RenderBranchRow } from "../branch-row";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import {
  deriveFilteredBranchAnalytics,
  selectVisibleWireRows,
} from "../filtered-branch-analytics";
import {
  fullCorpusBase,
  makeWireRow,
} from "./filtered-branch-analytics-fixtures";

describe("deriveFilteredBranchAnalytics", () => {
  it("preserves producer-owned canonical metrics without lossy reaggregation", () => {
    const canonicalMetrics = projectCanonicalBranchListMetrics({
      branches: [],
      pullRequests: [],
      pullRequestCoverageComplete: true,
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
    const base = { ...fullCorpusBase(), canonicalMetrics };

    const result = deriveFilteredBranchAnalytics(
      base,
      [makeWireRow({ id: "visible", status: BranchStatus.Open })],
      DEFAULT_BRANCH_FILTERS
    );

    expect(result.canonicalMetrics).toBe(canonicalMetrics);
  });

  it("preserves omission and unknown future nested canonical states", () => {
    const omitted = deriveFilteredBranchAnalytics(
      fullCorpusBase(),
      [],
      DEFAULT_BRANCH_FILTERS
    );
    expect(omitted.canonicalMetrics).toBeUndefined();

    const futureBundle = JSON.parse(
      JSON.stringify(
        projectCanonicalBranchListMetrics({
          branches: [],
          pullRequests: [],
          pullRequestCoverageComplete: true,
          now: new Date("2026-08-03T00:00:00.000Z"),
        })
      )
    );
    futureBundle.activeBranches.current.state = "future_state";
    const preserved = deriveFilteredBranchAnalytics(
      { ...fullCorpusBase(), canonicalMetrics: futureBundle },
      [],
      DEFAULT_BRANCH_FILTERS
    );
    expect(preserved.canonicalMetrics).toBe(futureBundle);
  });

  // FEA-3694 — with NO facet active the header must still be derived from the
  // exact visible rows the surface supplies (search/pagination narrow that set
  // upstream). It must NOT short-circuit to the full-corpus base.
  it("derives header analytics from the visible rows even when no facet is active", () => {
    const base = fullCorpusBase();
    // Only TWO visible OPEN branches (the surface narrowed the corpus via
    // search/pagination). No facet filter is applied.
    const rows = [
      makeWireRow({ id: "b1", status: BranchStatus.Open }),
      makeWireRow({ id: "b2", status: BranchStatus.Open }),
    ];

    const result = deriveFilteredBranchAnalytics(
      base,
      rows,
      DEFAULT_BRANCH_FILTERS
    );

    // Re-derived over the two visible rows → 2 active branches, NOT the corpus's
    // 99 the early-return used to leak through.
    expect(result.activeBranchCount.value).toBe(2);
    expect(result.activeBranchCount.state).toBe(BranchKpiState.Available);
    // A re-derived KPI drops the full-corpus 30-day baseline/delta.
    expect(result.activeBranchCount.baseline30d).toBeNull();
    expect(result.activeBranchCount.deltaPct).toBeNull();
  });

  it("re-derives spend from the narrowed visible rows with no facet active", () => {
    const base = fullCorpusBase();
    // A search/pagination-narrowed visible set of a single priced branch. The
    // corpus base reports $1000; the header must reflect just the visible $40.
    const rows = [
      makeWireRow({
        id: "b1",
        status: BranchStatus.Open,
        estimatedCostUsd: 40,
        sessionIds: ["s1"],
      }),
    ];

    const result = deriveFilteredBranchAnalytics(
      base,
      rows,
      DEFAULT_BRANCH_FILTERS
    );

    expect(result.totalSpendUsd.value).toBeCloseTo(40);
    expect(result.totalSpendUsd.state).toBe(BranchKpiState.Available);
  });

  it("re-derives header analytics from the visible rows on a search-only narrow (facets empty)", () => {
    const base = fullCorpusBase();
    // The full corpus has THREE open branches; search narrowed the visible set
    // to two of them. No facet is active — a search-only case.
    const rows = [
      makeWireRow({ id: "b1", status: BranchStatus.Open }),
      makeWireRow({ id: "b2", status: BranchStatus.Merged }),
    ];

    const result = deriveFilteredBranchAnalytics(
      base,
      rows,
      DEFAULT_BRANCH_FILTERS
    );

    // Only b1 is active among the visible rows → 1, not the corpus's 99.
    expect(result.activeBranchCount.value).toBe(1);
    expect(result.mergedCount.value).toBe(0);
  });

  it("applies a facet as an ADDITIONAL narrow on top of the visible rows (facet-only)", () => {
    const base = fullCorpusBase();
    // Visible set is already the full corpus here; the facet is the only narrow.
    const rows = [
      makeWireRow({ id: "b1", status: BranchStatus.Open }),
      makeWireRow({ id: "b2", status: BranchStatus.Open }),
      makeWireRow({ id: "b3", status: BranchStatus.Merged }),
    ];

    const result = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      statuses: ["open"],
    });

    // The status facet keeps the two open rows → 2 active branches.
    expect(result.activeBranchCount.value).toBe(2);
  });

  it("re-derives active-branch count over the filtered (status) subset", () => {
    const base = fullCorpusBase();
    const rows = [
      makeWireRow({ id: "b1", status: BranchStatus.Open }),
      makeWireRow({ id: "b2", status: BranchStatus.Open }),
      makeWireRow({ id: "b3", status: BranchStatus.Merged }),
    ];

    const result = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      statuses: ["open"],
    });

    // Two open branches, both active → 2 (not the corpus's 99).
    expect(result.activeBranchCount.value).toBe(2);
    expect(result.activeBranchCount.state).toBe(BranchKpiState.Available);
    // A filtered KPI drops the full-corpus 30-day baseline/delta — comparing a
    // filtered value against the whole-corpus prior window is apples-to-oranges.
    expect(result.activeBranchCount.baseline30d).toBeNull();
    expect(result.activeBranchCount.deltaPct).toBeNull();
  });

  it("matches null-repo rows through the repo facet exactly as the table does", () => {
    const base = fullCorpusBase();
    const rows = [
      // Null repoFullName → rendered/faceted under the "—" placeholder.
      makeWireRow({ id: "b1", repoFullName: null, status: BranchStatus.Open }),
      makeWireRow({
        id: "b2",
        repoFullName: "acme/web",
        status: BranchStatus.Open,
      }),
    ];

    const result = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      repos: ["—"],
    });

    // Only the null-repo branch matches the "—" facet → 1 active branch.
    expect(result.activeBranchCount.value).toBe(1);
  });

  // FEA-4003 — the linked-session presence facet must narrow the re-derived
  // header exactly like the table: a wire row `has` a session when its
  // `sessionIds` is non-empty, else `none`.
  it("re-derives header analytics over the linked-session presence facet subset", () => {
    const base = fullCorpusBase();
    const rows = [
      makeWireRow({
        id: "b1",
        status: BranchStatus.Open,
        sessionIds: ["s1"],
      }),
      makeWireRow({ id: "b2", status: BranchStatus.Open, sessionIds: [] }),
    ];

    const hasResult = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      sessionPresence: [BranchSessionPresence.Has],
    });
    // Only the branch with a linked session survives → 1 active branch.
    expect(hasResult.activeBranchCount.value).toBe(1);

    const noneResult = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      sessionPresence: [BranchSessionPresence.None],
    });
    // Only the session-less branch survives → 1 active branch.
    expect(noneResult.activeBranchCount.value).toBe(1);
  });

  // FEA-4003 — the LOC-change range facet must narrow the re-derived header on
  // `additions + deletions`, EXCLUDING rows whose LOC is unavailable (both null)
  // once a bound is set — mirroring the render-row predicate.
  it("re-derives header analytics over the LOC-range facet subset (excludes unavailable LOC)", () => {
    const base = fullCorpusBase();
    const rows = [
      makeWireRow({
        id: "small",
        status: BranchStatus.Open,
        additions: 3,
        deletions: 2, // 5
      }),
      makeWireRow({
        id: "big",
        status: BranchStatus.Open,
        additions: 400,
        deletions: 100, // 500
      }),
      // LOC unavailable (both null) → excluded once a bound is set.
      makeWireRow({
        id: "unavailable",
        status: BranchStatus.Open,
        additions: null,
        deletions: null,
      }),
    ];

    const windowed = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      locMin: 1,
      locMax: 10,
    });
    // The [1,10] window keeps only `small`(5); `big`(500) is out of range and
    // `unavailable` is excluded → 1 active branch.
    expect(windowed.activeBranchCount.value).toBe(1);

    const lowerBounded = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      locMin: 100,
    });
    // `big`(500) passes; `small`(5) and `unavailable` (excluded) do not → 1.
    expect(lowerBounded.activeBranchCount.value).toBe(1);

    const noMatch = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      locMin: 10,
      locMax: 100,
    });
    // The [10,100] window keeps neither LOC-bearing row → the empty subset
    // reports UNAVAILABLE (null), not a misleading 0.
    expect(noMatch.activeBranchCount.value).toBeNull();
    expect(noMatch.activeBranchCount.state).toBe(BranchKpiState.Unavailable);
  });

  it("re-derives merge rate over decided single-PR branches in the subset", () => {
    const base = fullCorpusBase();
    const rows = [
      // owner alice, merged
      makeWireRow({ id: "b1", owner: "alice", prState: GitHubPRState.Merged }),
      // owner alice, closed (decided, not merged)
      makeWireRow({ id: "b2", owner: "alice", prState: GitHubPRState.Closed }),
      // owner bob, merged — excluded by the owner filter
      makeWireRow({ id: "b3", owner: "bob", prState: GitHubPRState.Merged }),
      // owner alice, multi-PR merged — excluded (ambiguous lifecycle)
      makeWireRow({
        id: "b4",
        owner: "alice",
        prState: GitHubPRState.Merged,
        multiPrWarning: true,
      }),
    ];

    const result = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      owners: ["alice"],
    });

    // Among alice's single-PR decided branches: 1 merged / 2 decided = 50%.
    expect(result.mergeRate.value).toBe(50);
    expect(result.mergeRate.state).toBe(BranchKpiState.Available);
    expect(result.mergedCount.value).toBe(1);
    expect(result.activePrCount.value).toBe(0);
  });

  it("FEA-4333: a stale-open PR carrying mergedAt classifies as merged, not active (no double-classification)", () => {
    const base = fullCorpusBase();
    const rows = [
      // The stale-open-but-merged PR: GitHub raw state is still OPEN, but the
      // merge evidence (mergedAt) is present. It must count ONLY as merged.
      makeWireRow({
        id: "stale",
        prState: GitHubPRState.Open,
        mergedAt: "2026-06-11T09:00:00.000Z",
      }),
      // A genuinely-active OPEN PR with no merge evidence.
      makeWireRow({
        id: "active",
        prState: GitHubPRState.Open,
        mergedAt: null,
      }),
    ];

    const result = deriveFilteredBranchAnalytics(
      base,
      rows,
      DEFAULT_BRANCH_FILTERS
    );

    // The stale-open+merged PR is merged, the plain OPEN PR is active — mutually
    // exclusive, so the stale PR is NOT double-counted across the two KPIs.
    expect(result.mergedCount.value).toBe(1);
    expect(result.activePrCount.value).toBe(1);
    // Merge rate: 1 merged / 1 decided (merged + closed) = 100%. Before the fix
    // the stale row was neither merged nor decided, so the rate was unavailable.
    expect(result.mergeRate.value).toBe(100);
    expect(result.mergeRate.state).toBe(BranchKpiState.Available);
  });

  it("FEA-4333: without mergedAt (older producer), classification falls back to raw prState", () => {
    const base = fullCorpusBase();
    // A pre-FEA-4333 producer omits mergedAt; an OPEN PR then counts as active,
    // preserving the old behavior for a genuinely-open PR (safe default).
    const rows = [makeWireRow({ id: "open", prState: GitHubPRState.Open })];

    const result = deriveFilteredBranchAnalytics(
      base,
      rows,
      DEFAULT_BRANCH_FILTERS
    );

    expect(result.activePrCount.value).toBe(1);
    expect(result.mergedCount.value).toBe(0);
  });

  it("re-derives median PR size over merged, LOC-enriched single-PR branches", () => {
    const base = fullCorpusBase();
    const rows = [
      makeWireRow({
        id: "b1",
        status: BranchStatus.Merged,
        additions: 10,
        deletions: 5,
      }), // 15
      makeWireRow({
        id: "b2",
        status: BranchStatus.Merged,
        additions: 40,
        deletions: 5,
      }), // 45
      // un-enriched merged → excluded, not folded in as 0
      makeWireRow({ id: "b3", status: BranchStatus.Merged }),
      // open → excluded by the status filter
      makeWireRow({
        id: "b4",
        status: BranchStatus.Open,
        additions: 100,
        deletions: 100,
      }),
    ];

    const result = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      statuses: ["merged"],
    });

    // median(15, 45) = 30.
    expect(result.medianPrSize.value).toBe(30);
    expect(result.medianPrSize.state).toBe(BranchKpiState.Available);
  });

  // FEA-4268: a row whose DISPLAYED LOC was backfilled from the connected PR
  // (`resolveDetailLoc`) carries a null FILE-CACHE analytics basis
  // (`analyticsAdditions`/`analyticsDeletions`). The median must read the analytics
  // basis, NOT the display value, so that PR-backfilled row is EXCLUDED — keeping
  // the client KPI in parity with the server's `analyticsPullRequestSize`.
  it("excludes a PR-backfilled row from median PR size, reading the file-cache analytics basis not the display LOC", () => {
    const base = fullCorpusBase();
    const rows = [
      // File-cache enriched: display == analytics basis. Size 15.
      makeWireRow({
        id: "b1",
        status: BranchStatus.Merged,
        additions: 10,
        deletions: 5,
        analyticsAdditions: 10,
        analyticsDeletions: 5,
      }),
      // PR-backfilled DISPLAY (500 shown) but file-cache un-enriched (analytics
      // basis null) → must NOT count toward the median. If the median read the
      // DISPLAY value it would become median(15, 500) = 257.5.
      makeWireRow({
        id: "b2",
        status: BranchStatus.Merged,
        additions: 300,
        deletions: 200,
        analyticsAdditions: null,
        analyticsDeletions: null,
      }),
    ];

    const result = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      statuses: ["merged"],
    });

    // Only b1 (file-cache enriched) counts → median(15) = 15, never 257.5.
    expect(result.medianPrSize.value).toBe(15);
    expect(result.medianPrSize.state).toBe(BranchKpiState.Available);
  });

  it("recomputes deduped AI spend over the filtered subset without double-counting a shared session", () => {
    const base = fullCorpusBase();
    const rows = [
      // Two branches share session s1; each attributes the full $100.
      makeWireRow({
        id: "b1",
        owner: "alice",
        estimatedCostUsd: 100,
        sessionIds: ["s1"],
      }),
      makeWireRow({
        id: "b2",
        owner: "alice",
        estimatedCostUsd: 100,
        sessionIds: ["s1"],
      }),
      // Excluded by the owner filter.
      makeWireRow({
        id: "b3",
        owner: "bob",
        estimatedCostUsd: 500,
        sessionIds: ["s9"],
      }),
    ];

    const result = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      owners: ["alice"],
    });

    // s1 counted ONCE: $50 + $50 = $100, NOT $200 (no double-count) and NOT the
    // corpus's $1000.
    expect(result.totalSpendUsd.value).toBeCloseTo(100);
    expect(result.totalSpendUsd.state).toBe(BranchKpiState.Available);
  });

  it("marks spend unavailable when the filtered subset has no priced cost", () => {
    const base = fullCorpusBase();
    const rows = [
      makeWireRow({ id: "b1", owner: "alice", estimatedCostUsd: null }),
      makeWireRow({ id: "b2", owner: "bob", estimatedCostUsd: 500 }),
    ];

    const result = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      owners: ["alice"],
    });

    expect(result.totalSpendUsd.value).toBeNull();
    expect(result.totalSpendUsd.state).toBe(BranchKpiState.Unavailable);
  });

  // FEA-3695 — filtered spend and KLOC-per-$ must count each session's cost
  // EXACTLY ONCE using the authoritative per-session `sessionCostUsd` map, never
  // the lossy even-split-then-MAX inference over per-branch totals (which is
  // non-additive and over-counts). The non-nullable dedup key is the session id.
  describe("authoritative per-session spend (FEA-3695, no double-count)", () => {
    it("counts the AC counterexample once: {s1:$90,s2:$10} + {s1:$90} = $100, not $140", () => {
      const base = fullCorpusBase();
      // Branch A links s1+s2; its per-branch total is the SUM $100. Branch B links
      // s1 alone; its total is $90. The old even-split-then-MAX inference reported
      // $140 (s1→max(50,90)=90, s2→50). The authoritative map dedups on session id.
      const rows = [
        makeWireRow({
          id: "bA",
          owner: "alice",
          estimatedCostUsd: 100,
          sessionIds: ["s1", "s2"],
        }),
        makeWireRow({
          id: "bB",
          owner: "alice",
          estimatedCostUsd: 90,
          sessionIds: ["s1"],
        }),
      ];
      const sessionCostUsd = { s1: 90, s2: 10 };

      const result = deriveFilteredBranchAnalytics(
        base,
        rows,
        { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
        sessionCostUsd
      );

      // s1 ($90) + s2 ($10), each once = $100 — the authoritative unique-session
      // spend — NOT the $140 the inference fabricated.
      expect(result.totalSpendUsd.value).toBeCloseTo(100);
      expect(result.totalSpendUsd.state).toBe(BranchKpiState.Available);
    });

    it("counts a session shared across branches once (duplicate links), stable under branch ordering", () => {
      const base = fullCorpusBase();
      // s1 appears on THREE branches (incl. a duplicate link within bB); s2 on one.
      const rows = [
        makeWireRow({
          id: "bA",
          owner: "alice",
          estimatedCostUsd: 70,
          sessionIds: ["s1", "s2"],
        }),
        makeWireRow({
          id: "bB",
          owner: "alice",
          estimatedCostUsd: 60,
          // Duplicate link to s1 within one branch's id list — must not re-add.
          sessionIds: ["s1", "s1"],
        }),
        makeWireRow({
          id: "bC",
          owner: "alice",
          estimatedCostUsd: 60,
          sessionIds: ["s1"],
        }),
      ];
      const sessionCostUsd = { s1: 60, s2: 10 };
      const filters = { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] };

      const forward = deriveFilteredBranchAnalytics(
        base,
        rows,
        filters,
        sessionCostUsd
      );
      // Reverse the row order — totals must be identical (order-independent).
      const reversed = deriveFilteredBranchAnalytics(
        base,
        [...rows].reverse(),
        filters,
        sessionCostUsd
      );

      // s1 ($60) once + s2 ($10) once = $70, regardless of ordering/duplication.
      expect(forward.totalSpendUsd.value).toBeCloseTo(70);
      expect(reversed.totalSpendUsd.value).toBeCloseTo(70);
    });

    it("PROPERTY: filtered spend never exceeds the authoritative unique population", () => {
      const base = fullCorpusBase();
      // Every filtered session's authoritative cost, each present once, is the
      // ceiling. Whatever overlap the branch links carry, the derived total must
      // stay <= that unique sum (the #3695 invariant).
      const sessionCostUsd = { s1: 90, s2: 10, s3: 33, s4: 7 };
      const uniquePopulation = Object.values(sessionCostUsd).reduce(
        (sum, cost) => sum + cost,
        0
      );
      const rows = [
        makeWireRow({
          id: "bA",
          owner: "alice",
          estimatedCostUsd: 999, // deliberately inflated per-branch total
          sessionIds: ["s1", "s2", "s3"],
        }),
        makeWireRow({
          id: "bB",
          owner: "alice",
          estimatedCostUsd: 999,
          sessionIds: ["s1", "s3", "s4"], // heavy overlap with bA
        }),
        makeWireRow({
          id: "bC",
          owner: "alice",
          estimatedCostUsd: 999,
          sessionIds: ["s2", "s4"],
        }),
      ];

      const result = deriveFilteredBranchAnalytics(
        base,
        rows,
        { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
        sessionCostUsd
      );

      // All four sessions are visible → exactly the unique population, and never
      // more (no per-branch total ever leaks in).
      expect(result.totalSpendUsd.value).toBeCloseTo(uniquePopulation);
      expect(result.totalSpendUsd.value ?? 0).toBeLessThanOrEqual(
        uniquePopulation
      );
    });

    it("treats zero/unknown session cost correctly: priced-zero adds $0 to the sum, absent (unknown) omitted", () => {
      const base = fullCorpusBase();
      const rows = [
        makeWireRow({
          id: "bA",
          owner: "alice",
          estimatedCostUsd: 40,
          sessionIds: ["sZero", "sUnknown"],
        }),
        makeWireRow({
          id: "bB",
          owner: "alice",
          estimatedCostUsd: 40,
          sessionIds: ["sPriced"],
        }),
      ];
      // sZero is priced-zero (present, $0 — contributes $0 to the sum);
      // sUnknown has NO map entry (unknown cost — omitted); sPriced is $25.
      const sessionCostUsd = { sZero: 0, sPriced: 25 };

      const result = deriveFilteredBranchAnalytics(
        base,
        rows,
        { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
        sessionCostUsd
      );

      // $0 (sZero) + $25 (sPriced) = $25; sUnknown contributes nothing. The card
      // is Available because that TOTAL is a reportable positive figure
      // (ISS-4737) — not merely because the cost map has an entry in it. A
      // zero-priced session like sZero no longer makes spend available on its
      // own; see the null-on-zero suite below.
      expect(result.totalSpendUsd.value).toBeCloseTo(25);
      expect(result.totalSpendUsd.state).toBe(BranchKpiState.Available);
    });

    it("KLOC-per-$ uses the deduped shared-session denominator, not the double-counted one", () => {
      const base = fullCorpusBase();
      // Two LOC-enriched branches share s1. Churn = (10+5) + (20+10) = 45. The
      // even-split denominator apportions s1's authoritative $50 across the two
      // branches it touched (both enriched) → $25 + $25 = $50. So 45/50 = 0.9.
      // The old inference would have split each branch's per-branch total,
      // fabricating a different (inflated) denominator.
      const rows = [
        makeWireRow({
          id: "bA",
          owner: "alice",
          status: BranchStatus.Open,
          additions: 10,
          deletions: 5,
          estimatedCostUsd: 50,
          sessionIds: ["s1"],
        }),
        makeWireRow({
          id: "bB",
          owner: "alice",
          status: BranchStatus.Open,
          additions: 20,
          deletions: 10,
          estimatedCostUsd: 50,
          sessionIds: ["s1"],
        }),
      ];
      const sessionCostUsd = { s1: 50 };

      const result = deriveFilteredBranchAnalytics(
        base,
        rows,
        { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
        sessionCostUsd
      );

      // 45 churn / $50 deduped enriched spend = 0.9.
      expect(result.locPerDollar.value).toBeCloseTo(0.9);
      expect(result.locPerDollar.state).toBe(BranchKpiState.Available);
    });

    it("falls back to the legacy inference when no authoritative map is supplied (older producer)", () => {
      const base = fullCorpusBase();
      // Same shared-session rows; WITHOUT the map the helper uses the legacy
      // even-split-then-MAX path (unchanged behavior for stale producers).
      const rows = [
        makeWireRow({
          id: "b1",
          owner: "alice",
          estimatedCostUsd: 100,
          sessionIds: ["s1"],
        }),
        makeWireRow({
          id: "b2",
          owner: "alice",
          estimatedCostUsd: 100,
          sessionIds: ["s1"],
        }),
      ];

      const result = deriveFilteredBranchAnalytics(base, rows, {
        ...DEFAULT_BRANCH_FILTERS,
        owners: ["alice"],
      });

      // Legacy path: s1 → max($100, $100) = $100, still counted once.
      expect(result.totalSpendUsd.value).toBeCloseTo(100);
      expect(result.totalSpendUsd.state).toBe(BranchKpiState.Available);
    });
  });

  it("leaves gated GitHub-timing KPIs and the build/rework split untouched", () => {
    const base = fullCorpusBase();
    const rows = [makeWireRow({ id: "b1", status: BranchStatus.Open })];

    const result = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      statuses: ["open"],
    });

    expect(result.medianTimeToMergeMs).toEqual(base.medianTimeToMergeMs);
    expect(result.leadTimeForChangeMs).toEqual(base.leadTimeForChangeMs);
    expect(result.buildVsReworkSplit).toEqual(base.buildVsReworkSplit);
  });

  // FEA-3629 v2 — the #3281 gap: the re-projection was fed the RAW server
  // corpus, not the table's VISIBLE (windowed) set, so a facet re-derived KPIs
  // over rows the table had windowed out. The fix narrows to
  // `selectVisibleWireRows` first; these tests pin that base set.
  describe("re-projects over the table-visible corpus only (FEA-3629 v2)", () => {
    function renderRow(id: string): RenderBranchRow {
      return { id } as RenderBranchRow;
    }

    it("selectVisibleWireRows keeps only wire rows whose id is in the visible set", () => {
      const all = [
        makeWireRow({ id: "b1" }),
        makeWireRow({ id: "b2" }),
        makeWireRow({ id: "b3" }),
      ];

      const visible = selectVisibleWireRows(all, [
        renderRow("b1"),
        renderRow("b3"),
      ]);

      expect(visible.map((row) => row.id)).toEqual(["b1", "b3"]);
    });

    it("excludes rows the table windowed out when a facet is applied", () => {
      const base = fullCorpusBase();
      // Three OPEN branches in the raw corpus. The table only shows b1 (b2/b3
      // are out-of-window), so `visibleRows` carries just b1.
      const all = [
        makeWireRow({ id: "b1", status: BranchStatus.Open }),
        makeWireRow({ id: "b2", status: BranchStatus.Open }),
        makeWireRow({ id: "b3", status: BranchStatus.Open }),
      ];
      const visibleWire = selectVisibleWireRows(all, [renderRow("b1")]);

      const result = deriveFilteredBranchAnalytics(base, visibleWire, {
        ...DEFAULT_BRANCH_FILTERS,
        statuses: ["open"],
      });

      // Over the RAW corpus the old code would have reported 3 active branches;
      // over the visible set it is the single windowed row → 1. This is the
      // exact regression #3281 shipped.
      expect(result.activeBranchCount.value).toBe(1);
    });

    it("re-derives spend over only the visible rows (out-of-window cost excluded)", () => {
      const base = fullCorpusBase();
      const all = [
        makeWireRow({
          id: "b1",
          status: BranchStatus.Open,
          estimatedCostUsd: 40,
          sessionIds: ["s1"],
        }),
        // Out-of-window / hidden — must NOT be summed once a facet is applied.
        makeWireRow({
          id: "b2",
          status: BranchStatus.Open,
          estimatedCostUsd: 1000,
          sessionIds: ["s2"],
        }),
      ];
      const visibleWire = selectVisibleWireRows(all, [renderRow("b1")]);

      const result = deriveFilteredBranchAnalytics(base, visibleWire, {
        ...DEFAULT_BRANCH_FILTERS,
        statuses: ["open"],
      });

      expect(result.totalSpendUsd.value).toBeCloseTo(40);
    });
  });

  // ISS-4737 — the filtered re-projection must apply the SAME null-on-zero rule
  // the server producer applies (`reportableSpendUsd`). It used to key
  // availability on "the subset contains at least one priced session"
  // (`costBySession.size > 0`), so a subset whose priced sessions summed to
  // exactly $0 rendered `$0` — a card asserting the work was free — while the
  // server called the same corpus no-data.
  describe("AI spend is null-on-zero, matching the server producer (ISS-4737)", () => {
    it("marks a priced-but-zero-sum subset unavailable, not $0", () => {
      const base = fullCorpusBase();
      const rows = [
        makeWireRow({
          id: "b1",
          owner: "alice",
          estimatedCostUsd: 0,
          sessionIds: ["s1"],
        }),
      ];
      // s1 IS priced — it is present in the authoritative map — but its captured
      // cost is exactly zero. The old predicate saw one map entry and reported
      // an Available $0.
      const sessionCostUsd = { s1: 0 };

      const result = deriveFilteredBranchAnalytics(
        base,
        rows,
        { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
        sessionCostUsd
      );

      expect(result.totalSpendUsd.value).toBeNull();
      expect(result.totalSpendUsd.state).toBe(BranchKpiState.Unavailable);
    });

    it("marks a multi-session subset whose priced costs all sum to zero unavailable", () => {
      const base = fullCorpusBase();
      const rows = [
        makeWireRow({
          id: "bA",
          owner: "alice",
          estimatedCostUsd: 0,
          sessionIds: ["s1", "s2"],
        }),
        makeWireRow({
          id: "bB",
          owner: "alice",
          estimatedCostUsd: 0,
          sessionIds: ["s2"],
        }),
      ];
      const sessionCostUsd = { s1: 0, s2: 0 };

      const result = deriveFilteredBranchAnalytics(
        base,
        rows,
        { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
        sessionCostUsd
      );

      expect(result.totalSpendUsd.value).toBeNull();
      expect(result.totalSpendUsd.state).toBe(BranchKpiState.Unavailable);
    });

    it("marks a subset with NO priced session unavailable too (same rendered state, different cause)", () => {
      const base = fullCorpusBase();
      const rows = [
        makeWireRow({ id: "b1", owner: "alice", sessionIds: ["s1"] }),
      ];
      // s1 is absent from the authoritative map entirely — nothing priced. The
      // KPI has no state to distinguish this from a priced zero, so both land on
      // Unavailable; the distinction survives upstream in the cost map.
      const sessionCostUsd = { s9: 5 };

      const result = deriveFilteredBranchAnalytics(
        base,
        rows,
        { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
        sessionCostUsd
      );

      expect(result.totalSpendUsd.value).toBeNull();
      expect(result.totalSpendUsd.state).toBe(BranchKpiState.Unavailable);
    });

    it("still reports a real positive total, including one with zero-priced sessions in the mix", () => {
      const base = fullCorpusBase();
      const rows = [
        makeWireRow({
          id: "bA",
          owner: "alice",
          estimatedCostUsd: 25,
          sessionIds: ["s1", "s2"],
        }),
      ];
      // s2 priced at exactly zero must not suppress s1's real $25.
      const sessionCostUsd = { s1: 25, s2: 0 };

      const result = deriveFilteredBranchAnalytics(
        base,
        rows,
        { ...DEFAULT_BRANCH_FILTERS, owners: ["alice"] },
        sessionCostUsd
      );

      expect(result.totalSpendUsd.value).toBeCloseTo(25);
      expect(result.totalSpendUsd.state).toBe(BranchKpiState.Available);
    });

    it("applies the same rule on the legacy per-branch inference path (no authoritative map)", () => {
      const base = fullCorpusBase();
      // Older producer: no `sessionCostUsd`, so the helper falls back to the
      // per-branch even-split inference. A branch reporting $0 across its
      // sessions still yields a zero-valued map entry, not an empty map.
      const rows = [
        makeWireRow({
          id: "b1",
          owner: "alice",
          estimatedCostUsd: 0,
          sessionIds: ["s1"],
        }),
      ];

      const result = deriveFilteredBranchAnalytics(base, rows, {
        ...DEFAULT_BRANCH_FILTERS,
        owners: ["alice"],
      });

      expect(result.totalSpendUsd.value).toBeNull();
      expect(result.totalSpendUsd.state).toBe(BranchKpiState.Unavailable);
    });
  });
});
