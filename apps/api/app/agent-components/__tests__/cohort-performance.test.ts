/**
 * @file cohort-performance.test.ts
 * @description Unit + fake-db tests for the shared cohort delivery-performance
 * computation (FEA-2923 Performance tab). Pure math is tested directly; the DB
 * aggregation is exercised through a hand-rolled fake `db` that routes cohort vs.
 * baseline reads by their `where` shape — no real database.
 */
import { COHORT_SCAN_CAP } from "@repo/api/src/types/analytics";
import { LOC_SOURCE_BRANCH_FALLBACK } from "@repo/api/src/utils/session-loc";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The helper imports `@repo/database` only for a `typeof withDb` type + is called
// with a caller-supplied `db`; mock it so the module loads without a real client.
vi.mock("@repo/database", () => ({ withDb: vi.fn() }));

import {
  computeCohortPerformance,
  EMPTY_COHORT_METRICS,
  efficiencyTrendOf,
  klocPer1kTokensOf,
  locPerDollarOf,
  mean,
  pctDelta,
  ppDelta,
  sessionLoc,
  tokenEfficiencyDeltaOf,
  tokensPerKlocOf,
} from "../cohort-performance";

describe("pure math", () => {
  it("sessionLoc sums added + removed, treating null as 0", () => {
    expect(sessionLoc(100, 40)).toBe(140);
    expect(sessionLoc(null, 40)).toBe(40);
    expect(sessionLoc(null, null)).toBe(0);
  });

  it("locPerDollarOf: ISS-4667 raw lines/cost, null unless both positive", () => {
    expect(locPerDollarOf(2000, 4)).toBe(500);
    expect(locPerDollarOf(0, 4)).toBeNull();
    expect(locPerDollarOf(2000, 0)).toBeNull();
    expect(locPerDollarOf(-10, 4)).toBeNull();
  });

  it("tokensPerKlocOf: tokens/(loc/1000), null unless both positive", () => {
    expect(tokensPerKlocOf(10_000, 2000)).toBe(5000);
    expect(tokensPerKlocOf(0, 2000)).toBeNull();
    expect(tokensPerKlocOf(10_000, 0)).toBeNull();
  });

  it("klocPer1kTokensOf: KLOC per 1k tokens (higher = better)", () => {
    expect(klocPer1kTokensOf(2000, 4000)).toBe(0.5);
    expect(klocPer1kTokensOf(2000, 0)).toBeNull();
    expect(klocPer1kTokensOf(0, 4000)).toBeNull();
  });

  it("pctDelta: signed % lift, null when either null or baseline 0", () => {
    expect(pctDelta(120, 100)).toBe(20);
    expect(pctDelta(80, 100)).toBeCloseTo(-20);
    expect(pctDelta(120, 0)).toBeNull();
    expect(pctDelta(null, 100)).toBeNull();
    expect(pctDelta(120, null)).toBeNull();
    // Negative baseline uses |baseline| so the sign reflects direction.
    expect(pctDelta(-50, -100)).toBe(50);
  });

  it("tokenEfficiencyDeltaOf: positive when cohort spends FEWER tokens/KLOC", () => {
    // cohort 4000/KLOC vs baseline 5000/KLOC → 20% more efficient.
    expect(tokenEfficiencyDeltaOf(4000, 5000)).toBeCloseTo(20);
    // cohort worse (more tokens) → negative.
    expect(tokenEfficiencyDeltaOf(6000, 5000)).toBeCloseTo(-20);
    expect(tokenEfficiencyDeltaOf(null, 5000)).toBeNull();
    expect(tokenEfficiencyDeltaOf(4000, null)).toBeNull();
    expect(tokenEfficiencyDeltaOf(4000, 0)).toBeNull();
  });

  it("ppDelta: percentage-point difference, null when either null", () => {
    expect(ppDelta(74, 60)).toBe(14);
    expect(ppDelta(50, null)).toBeNull();
    expect(ppDelta(null, 60)).toBeNull();
  });

  it("mean: average or null when empty", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([])).toBeNull();
  });

  it("efficiencyTrendOf: empty input → [], single instant → last bucket", () => {
    expect(efficiencyTrendOf([])).toEqual([]);
    const single = efficiencyTrendOf([trendPoint(1000, 2000, 4000)], 4);
    expect(single).toHaveLength(4);
    // All in the last bucket (span 0); earlier buckets are 0.
    expect(single.slice(0, 3)).toEqual([0, 0, 0]);
    expect(single[3]).toBe(0.5);
  });

  it("efficiencyTrendOf: distributes points across time buckets", () => {
    const trend = efficiencyTrendOf(
      [
        trendPoint(0, 1000, 1000), // bucket 0 → 1.0
        trendPoint(100, 2000, 1000), // bucket 3 → 2.0
      ],
      4
    );
    expect(trend).toHaveLength(4);
    expect(trend[0]).toBe(1);
    expect(trend[3]).toBe(2);
    expect(trend[1]).toBe(0);
  });

  it("efficiencyTrendOf: dedups branch-fallback LOC per branch within a bucket", () => {
    // Two authoring sessions on ONE branch, each carrying the branch's 2000-line
    // fallback total, both in the same (single-instant) bucket → the branch total
    // counts ONCE (2000), so kloc/1k-tokens = 2000/1000 / (1000/1000) = 2, NOT 4.
    const trend = efficiencyTrendOf(
      [
        {
          time: 5,
          tokens: 500,
          loc: 2000,
          locSource: "branch_fallback",
          repositoryFullName: "org/repo",
          branch: "feat/shared",
        },
        {
          time: 5,
          tokens: 500,
          loc: 2000,
          locSource: "branch_fallback",
          repositoryFullName: "org/repo",
          branch: "feat/shared",
        },
      ],
      4
    );
    expect(trend[3]).toBe(2);
  });
});

/** A commit-sourced ("git") efficiency-trend point (per-session LOC, no dedup). */
function trendPoint(time: number, loc: number, tokens: number) {
  return {
    time,
    loc,
    tokens,
    locSource: "git",
    repositoryFullName: "org/repo",
    branch: "feat/x",
  };
}

// ---------------------------------------------------------------------------
// computeCohortPerformance — fake-db integration
// ---------------------------------------------------------------------------

const ORG = "org-1";

type MergedPr = { repo: string | null; number: number | null };

function row(opts: {
  id: string;
  loc?: number;
  cost?: number;
  tokens?: number;
  startedAt?: number;
  loopId?: string | null;
  mergedPrs?: MergedPr[];
}) {
  const tokens = opts.tokens ?? 0;
  return {
    artifactId: opts.id,
    linesAdded: opts.loc ?? 0,
    linesRemoved: 0,
    estimatedCost: opts.cost ?? 0,
    inputTokens: BigInt(Math.floor(tokens / 2)),
    outputTokens: BigInt(tokens - Math.floor(tokens / 2)),
    sessionStartedAt: new Date(opts.startedAt ?? 1000),
    sourceLoopId: opts.loopId ?? null,
    artifact: {
      sourceLinks: (opts.mergedPrs ?? []).map((pr, i) => ({
        targetId: `${opts.id}-branch-${i}`,
        target: {
          branch: {
            currentPullRequestDetail: {
              number: pr.number,
              prState: "MERGED",
              mergedAt: new Date(2000),
              isCurrent: true,
              repositoryFullName: pr.repo,
              repository: pr.repo ? { fullName: pr.repo } : null,
            },
          },
        },
      })),
    },
  };
}

/** Build a fake db that routes findMany by `where` shape and serves evals by loopId. */
function makeFakeDb(opts: {
  cohortRows: ReturnType<typeof row>[];
  baselineRows?: ReturnType<typeof row>[];
  baselineSum?: {
    linesAdded: number | null;
    linesRemoved: number | null;
    estimatedCost: number | null;
    inputTokens: bigint | null;
    outputTokens: bigint | null;
  };
  // FEA-3633: keyed branch-fallback baseline LOC groups (one per distinct branch,
  // MAX(added)+MAX(removed) counted once). Default none → per-session baseline LOC.
  fallbackGroups?: {
    _max: { linesAdded: number | null; linesRemoved: number | null };
  }[];
  scoresByLoopId?: Record<string, number[]>;
}) {
  const scores = opts.scoresByLoopId ?? {};
  return {
    sessionDetail: {
      findMany: vi.fn((args: { where: { artifactId?: { notIn?: unknown } } }) =>
        Promise.resolve(
          args.where.artifactId?.notIn
            ? (opts.baselineRows ?? [])
            : opts.cohortRows
        )
      ),
      // FEA-3633: `computeCohortPerformance` now issues THREE aggregate calls:
      //  1. tokens/cost baseline — `where` has NO `locSource` filter;
      //  2. non-fallback LOC baseline — `where.OR` filters locSource (git/null);
      //  3. unkeyable-fallback LOC — `where.locSource === "branch_fallback"`.
      // Route by the `where` shape so each returns the right slice of baselineSum.
      aggregate: vi.fn(
        (args: {
          where?: {
            locSource?: unknown;
            OR?: unknown;
          };
        }) => {
          const sum = opts.baselineSum ?? {
            linesAdded: null,
            linesRemoved: null,
            estimatedCost: null,
            inputTokens: null,
            outputTokens: null,
          };
          const where = args.where ?? {};
          if (where.locSource === LOC_SOURCE_BRANCH_FALLBACK) {
            // Unkeyable fallback LOC: none in these tests.
            return Promise.resolve({
              _sum: { linesAdded: null, linesRemoved: null },
            });
          }
          if (where.OR) {
            // Non-fallback LOC baseline (all baseline LOC is non-fallback here).
            return Promise.resolve({
              _sum: {
                linesAdded: sum.linesAdded,
                linesRemoved: sum.linesRemoved,
              },
            });
          }
          // tokens/cost baseline.
          return Promise.resolve({
            _sum: {
              estimatedCost: sum.estimatedCost,
              inputTokens: sum.inputTokens,
              outputTokens: sum.outputTokens,
            },
          });
        }
      ),
      // FEA-3633: keyed-fallback baseline LOC groups. Tests with fallback branches
      // pass `fallbackGroups`; the default (none) yields per-session baseline LOC.
      groupBy: vi.fn(() => Promise.resolve(opts.fallbackGroups ?? [])),
    },
    artifactEvaluation: {
      findMany: vi.fn((args: { where: { loopId: { in: string[] } } }) =>
        Promise.resolve(
          args.where.loopId.in.flatMap((loopId) =>
            (scores[loopId] ?? []).map((score) => ({
              judgeScores: [{ score }],
            }))
          )
        )
      ),
    },
    // A minimal structural fake satisfying only the reads the helper performs.
  } as unknown as Parameters<typeof computeCohortPerformance>[0];
}

describe("computeCohortPerformance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns EMPTY_COHORT_METRICS for an empty cohort (no query)", async () => {
    const db = makeFakeDb({ cohortRows: [] });
    const result = await computeCohortPerformance(db, ORG, []);
    expect(result).toEqual(EMPTY_COHORT_METRICS);
    expect(db.sessionDetail.findMany).not.toHaveBeenCalled();
  });

  it("returns EMPTY when the cohort ids resolve to no rows", async () => {
    const db = makeFakeDb({ cohortRows: [] });
    const result = await computeCohortPerformance(db, ORG, ["s1"]);
    expect(result).toEqual(EMPTY_COHORT_METRICS);
  });

  it("computes success rate + deduped merged PRs over the cohort", async () => {
    const db = makeFakeDb({
      cohortRows: [
        // Two sessions link the SAME PR (acme/repo#1) → counted once.
        row({ id: "s1", mergedPrs: [{ repo: "acme/repo", number: 1 }] }),
        row({ id: "s2", mergedPrs: [{ repo: "acme/repo", number: 1 }] }),
        row({ id: "s3", mergedPrs: [{ repo: "acme/repo", number: 2 }] }),
        row({ id: "s4", mergedPrs: [] }), // no merged PR
      ],
    });
    const result = await computeCohortPerformance(db, ORG, [
      "s1",
      "s2",
      "s3",
      "s4",
    ]);
    // 3 of 4 sessions reached a merged PR.
    expect(result.successRate).toBe(75);
    // Distinct PRs: #1 and #2.
    expect(result.mergedPrs).toBe(2);
  });

  it("computes kloc/token deltas vs. the baseline aggregate", async () => {
    const db = makeFakeDb({
      // Cohort: 4000 LOC, $2 → 2 KLOC/$; 4000 tokens → 1000 tokens/KLOC.
      cohortRows: [row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 })],
      // Baseline: 2000 LOC, $2 → 1 KLOC/$; 4000 tokens → 2000 tokens/KLOC.
      baselineSum: {
        linesAdded: 2000,
        linesRemoved: 0,
        estimatedCost: 2,
        inputTokens: 2000n,
        outputTokens: 2000n,
      },
    });
    const result = await computeCohortPerformance(db, ORG, ["s1"]);
    // KLOC/$ 2 vs 1 → +100%.
    expect(result.locDelta).toBeCloseTo(100);
    // tokens/KLOC 1000 vs 2000 → 50% more efficient.
    expect(result.tokenEfficiencyDelta).toBeCloseTo(50);
  });

  it("dedups branch-fallback LOC per branch in the baseline (FEA-3633)", async () => {
    // Baseline non-fallback LOC = 0; the fallback LOC lives entirely on ONE branch
    // shared by many sessions → MAX(added)+MAX(removed) = 2000 counted ONCE, NOT
    // once per session. With $2 baseline cost that's 1 KLOC/$; cohort 2 KLOC/$
    // (4000 LOC / $2) → +100%. If the baseline double-counted the branch (e.g.
    // 3×2000 = 6000 → 3 KLOC/$) the delta would be a wrong -33%.
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 })],
      baselineSum: {
        // Non-fallback baseline LOC is zero; cost/tokens drive the denominators.
        linesAdded: 0,
        linesRemoved: 0,
        estimatedCost: 2,
        inputTokens: 2000n,
        outputTokens: 2000n,
      },
      // One branch's fallback total, deduped to a single group.
      fallbackGroups: [{ _max: { linesAdded: 2000, linesRemoved: 0 } }],
    });
    const result = await computeCohortPerformance(db, ORG, ["s1"]);
    expect(result.locDelta).toBeCloseTo(100);
  });

  it("nulls the deltas when the baseline is empty (no fabrication)", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 })],
      // baselineSum defaults to all-null (no baseline sessions).
    });
    const result = await computeCohortPerformance(db, ORG, ["s1"]);
    expect(result.locDelta).toBeNull();
    expect(result.tokenEfficiencyDelta).toBeNull();
    // Absolute cohort success rate is still real (0 here — no PRs).
    expect(result.successRate).toBe(0);
  });

  it("averages judge scores over the cohort's loops (clamped 0–10)", async () => {
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", loopId: "loop-a" }),
        row({ id: "s2", loopId: "loop-b" }),
      ],
      scoresByLoopId: { "loop-a": [8, 9], "loop-b": [7] },
    });
    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"]);
    // mean(8, 9, 7) = 8.
    expect(result.qualityScore).toBe(8);
  });

  it("leaves quality null when no cohort session has an evaluation", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loopId: null })],
    });
    const result = await computeCohortPerformance(db, ORG, ["s1"]);
    expect(result.qualityScore).toBeNull();
    expect(result.qualityDelta).toBeNull();
    // Quality lookup is skipped entirely when there are no loop ids.
    expect(db.artifactEvaluation.findMany).not.toHaveBeenCalled();
  });

  it("produces an efficiency trend sparkline from cohort timing", async () => {
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", loc: 1000, tokens: 1000, startedAt: 0 }),
        row({ id: "s2", loc: 2000, tokens: 1000, startedAt: 1000 }),
      ],
    });
    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"]);
    expect(result.efficiencyTrend).toHaveLength(8);
    // Earliest window carries s1 (1.0), latest carries s2 (2.0).
    expect(result.efficiencyTrend[0]).toBe(1);
    expect(result.efficiencyTrend.at(-1)).toBe(2);
  });

  it("does NOT collapse number-less merged PRs from the same repo", async () => {
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", mergedPrs: [{ repo: "acme/repo", number: null }] }),
        row({ id: "s2", mergedPrs: [{ repo: "acme/repo", number: null }] }),
      ],
    });
    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"]);
    // Two distinct PRs (keyed by branch id), not one `acme/repo#null` bucket.
    expect(result.mergedPrs).toBe(2);
    expect(result.successRate).toBe(100);
  });

  it("skips the baseline (null deltas) when the cohort exceeds the scan cap", async () => {
    // Cohort larger than COHORT_SCAN_CAP (2000): a baseline that excludes only
    // the scanned subset would be contaminated, so deltas are intentionally null
    // and no baseline query is issued (bounded, no OOM).
    const ids = Array.from({ length: 2001 }, (_, i) => `s${i}`);
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s0", loc: 4000, cost: 2, tokens: 4000, mergedPrs: [] }),
        row({ id: "s1", mergedPrs: [{ repo: "acme/repo", number: 1 }] }),
      ],
      baselineSum: {
        linesAdded: 2000,
        linesRemoved: 0,
        estimatedCost: 2,
        inputTokens: 2000n,
        outputTokens: 2000n,
      },
    });
    const result = await computeCohortPerformance(db, ORG, ids);
    // Absolute metrics still computed over the bounded scan.
    expect(result.successRate).toBe(50);
    expect(result.mergedPrs).toBe(1);
    // Deltas suppressed; the baseline aggregate was never queried.
    expect(result.locDelta).toBeNull();
    expect(result.successDelta).toBeNull();
    expect(result.tokenEfficiencyDelta).toBeNull();
    expect(db.sessionDetail.aggregate).not.toHaveBeenCalled();
  });

  // ISS-5521: the cap is fine; a capped `mergedPrs` presented as covering the
  // whole cohort is not. The reader cannot see `scanIds` — the response has to
  // carry the fact, or the card has no way to know its own population.
  it("reports mergedPrsTruncated when the cohort exceeds the scan cap", async () => {
    const ids = Array.from({ length: COHORT_SCAN_CAP + 1 }, (_, i) => `s${i}`);
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", mergedPrs: [{ repo: "acme/repo", number: 1 }] }),
      ],
    });

    const result = await computeCohortPerformance(db, ORG, ids);

    // The count itself is unchanged — it is a FLOOR over the scanned slice, and
    // suppressing it would trade an overstated number for a missing one.
    expect(result.mergedPrs).toBe(1);
    expect(result.mergedPrsTruncated).toBe(true);
  });

  it("does not report truncation for a cohort that fits the scan cap exactly", async () => {
    const ids = Array.from({ length: COHORT_SCAN_CAP }, (_, i) => `s${i}`);
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", mergedPrs: [{ repo: "acme/repo", number: 1 }] }),
      ],
    });

    const result = await computeCohortPerformance(db, ORG, ids);

    // Exactly `COHORT_SCAN_CAP` ids are all scanned — `slice(0, cap)` drops
    // nothing — so the count DOES cover the whole cohort and must not be
    // caveated. An off-by-one here would caveat an honest number on every
    // component that happens to sit on the boundary.
    expect(result.mergedPrsTruncated).toBe(false);
  });
});
