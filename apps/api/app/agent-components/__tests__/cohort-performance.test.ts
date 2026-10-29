/**
 * @file cohort-performance.test.ts
 * @description Unit + fake-db tests for the shared cohort delivery-performance
 * computation (FEA-2923 Performance tab). Pure math is tested directly; the DB
 * aggregation is exercised through the shared `cohort-performance.test-db`
 * fake, which routes cohort vs. baseline reads by their `where` shape — no real
 * database.
 */
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The helper is called with a caller-supplied `db`; mock the raw-SQL builder so
// the fake DB can accept `$queryRaw(Prisma.sql`...`)` without a real client.
vi.mock("@repo/database", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ values }),
  },
  withDb: vi.fn(),
}));

import {
  cohortPrLink,
  type FakeSessionQuery,
  makeFakeDb,
  ORG,
  row,
} from "@/__tests__/support/agent-components/cohort-performance.test-db";
import {
  computeCohortPerformance,
  EMPTY_COHORT_METRICS,
  efficiencyTrendOf,
  klocPer1kTokensOf,
  pctDelta,
  ppDelta,
  sessionLoc,
  tokenEfficiencyDeltaOf,
  tokensPerLocOf,
} from "../cohort-performance";

describe("pure math", () => {
  it("sessionLoc sums added + removed, treating null as 0", () => {
    expect(sessionLoc(100, 40)).toBe(140);
    expect(sessionLoc(null, 40)).toBe(40);
    expect(sessionLoc(null, null)).toBe(0);
  });

  it("tokensPerLocOf: tokens/loc, null unless both positive", () => {
    // ISS-8184 ruling 5: 5 tokens per line, where this pinned 5000 per KLOC.
    // The 1000x drop is the ruling; nothing renders this value raw, and its one
    // consumer is a scale-invariant percentage delta.
    expect(tokensPerLocOf(10_000, 2000)).toBe(5);
    expect(tokensPerLocOf(0, 2000)).toBeNull();
    expect(tokensPerLocOf(10_000, 0)).toBeNull();
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
    // The chip renders this raw, so 12.63…% must arrive as a whole percent.
    expect(pctDelta(107, 95)).toBe(13);
  });

  it("tokenEfficiencyDeltaOf: positive when cohort spends FEWER tokens/KLOC", () => {
    // cohort 4000/KLOC vs baseline 5000/KLOC → 20% more efficient.
    expect(tokenEfficiencyDeltaOf(4000, 5000)).toBeCloseTo(20);
    // cohort worse (more tokens) → negative.
    expect(tokenEfficiencyDeltaOf(6000, 5000)).toBeCloseTo(-20);
    expect(tokenEfficiencyDeltaOf(null, 5000)).toBeNull();
    expect(tokenEfficiencyDeltaOf(4000, null)).toBeNull();
    expect(tokenEfficiencyDeltaOf(4000, 0)).toBeNull();
    // 13.58% → a whole percent, not the raw float.
    expect(tokenEfficiencyDeltaOf(4321, 5000)).toBe(14);
  });

  it("ppDelta: percentage-point difference, null when either null", () => {
    expect(ppDelta(74, 60)).toBe(14);
    // 14.29 points → a whole point, not the raw float.
    expect(ppDelta(74.4, 60.1)).toBe(14);
    expect(ppDelta(50, null)).toBeNull();
    expect(ppDelta(null, 60)).toBeNull();
  });

  it("efficiencyTrendOf: folds a cohort too wide to spread as arguments", () => {
    // `Math.min(...times)` passes one ARGUMENT per row and throws `RangeError`
    // once the stack cannot hold them — measured in this worker at 500,000
    // (125,000 and 200,000 still pass, so the count here is not decorative).
    // The retired 2,000-row scan cap made that unreachable; the ISS-9853 walk
    // does not, and the failure would be a 500 on the whole detail read.
    // `baselineWindowFor` folds its own window bounds through the same helper.
    const points = Array.from({ length: 500_000 }, (_u, index) => ({
      time: index,
      tokens: 1000,
      loc: 1000,
      locSource: null,
      repositoryFullName: null,
      branch: null,
    }));

    expect(efficiencyTrendOf(points)).toHaveLength(8);
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

describe("computeCohortPerformance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns EMPTY_COHORT_METRICS for an empty cohort (no query)", async () => {
    const db = makeFakeDb({ cohortRows: [] });
    const result = await computeCohortPerformance(db, ORG, [], {
      cohortSampled: false,
    });
    expect(result).toEqual(EMPTY_COHORT_METRICS);
    expect(db.sessionDetail.findMany).not.toHaveBeenCalled();
  });

  it("returns EMPTY when the cohort ids resolve to no rows", async () => {
    const db = makeFakeDb({ cohortRows: [] });
    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });
    expect(result).toEqual(EMPTY_COHORT_METRICS);
  });

  // ISS-9853 (Test Modification Guardrail): this case asserted
  // `take === COHORT_SCAN_CAP`. The EXPECTATION changed, not the test — the cap
  // is gone, because a `take` on a read keyed by primary key was serving the
  // first 2,000 of an insertion-ordered id set as the whole cohort (PRD-666).
  // What the read owes now is the opposite: every id, no row bound at all.
  it("scopes the cohort walk to the caller's org and bounds no rows", async () => {
    const sessionQueries: FakeSessionQuery[] = [];
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1" })],
      sessionQueries,
    });

    await computeCohortPerformance(db, ORG, ["s2", "s1"], {
      cohortSampled: false,
    });

    const [cohortQuery] = sessionQueries;
    expect(cohortQuery?.where.artifact).toEqual({ organizationId: ORG });
    // Sorted, so a chunk is one contiguous slice of the key space.
    expect(cohortQuery?.where.artifactId?.in).toEqual(["s1", "s2"]);
    expect(cohortQuery?.orderBy).toEqual([{ artifactId: "asc" }]);
    expect(cohortQuery?.take).toBeUndefined();
  });

  it("returns EMPTY when the cohort ids live in another org", async () => {
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", mergedPrs: [{ repo: "acme/repo", number: 1 }] }),
      ],
      organizationId: "org-2",
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

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
    const result = await computeCohortPerformance(
      db,
      ORG,
      ["s1", "s2", "s3", "s4"],
      { cohortSampled: false }
    );
    // 3 of 4 sessions reached a merged PR.
    expect(result.successRate).toBe(75);
    // Distinct PRs: #1 and #2.
    expect(result.mergedPrs).toBe(2);
  });

  it("counts only declared PRs when a reused branch has an incidental current PR", async () => {
    const base = row({ id: "s1" });
    const pr = (number: number, isCurrent: boolean) => ({
      number,
      prState: GitHubPRState.Merged,
      mergedAt: new Date(2000 + number),
      isCurrent,
      lastVerifiedAt: new Date(2100 + number),
      repositoryFullName: "acme/repo",
      repository: { fullName: "acme/repo" },
    });
    base.artifact.sourceLinks = [
      {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          linkKinds: [SessionArtifactLinkKind.SessionPrSet],
          prRefs: [1, 2].map((prNumber) => ({
            repositoryFullName: "acme/repo",
            prNumber,
            relationTypes: [SessionPrRelationType.Created],
          })),
        },
        targetId: "branch-reused",
        target: {
          branch: {
            repository: { fullName: "acme/repo" },
            currentPullRequestDetail: pr(3, true),
          },
          pullRequestDetails: [pr(1, false), pr(2, false), pr(3, true)],
        },
      },
    ];
    const db = makeFakeDb({ cohortRows: [base] });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    expect(result.successRate).toBe(100);
    expect(result.mergedPrs).toBe(2);
  });

  it("uses unique-Branch fallback for valid legacy metadata", async () => {
    const base = row({ id: "legacy" });
    base.artifact.sourceLinks = [
      cohortPrLink({ linkKind: SessionArtifactLinkKind.SessionPr }),
    ];
    const result = await computeCohortPerformance(
      makeFakeDb({ cohortRows: [base] }),
      ORG,
      ["legacy"],
      { cohortSampled: false }
    );

    expect(result.successRate).toBe(100);
    expect(result.mergedPrs).toBe(1);
  });

  it.each([
    [
      "canonical empty",
      { linkKind: SessionArtifactLinkKind.SessionPr, prRefs: [] },
    ],
    [
      "stale scalar plus empty",
      {
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: "stale/repo",
        prNumber: 99,
        prRefs: [],
      },
    ],
    [
      "malformed",
      { linkKind: SessionArtifactLinkKind.SessionPr, prRefs: "bad" },
    ],
    // ISS-8051 retired a fourth shape here: an over-500 `prRefs` array, which
    // this table asserted failed closed. That was the defect — the read schema's
    // `.max()` made `safeParse` fail, which classifies as `invalid` and discards
    // the whole stored PR set of a link the cloud had already accepted and
    // written, so the cohort scored it as if the session had shipped nothing.
    // The expectation itself changed rather than being weakened to pass; the
    // replacement readback contract is asserted in
    // `packages/api/src/types/session-pr-link-metadata.test.ts`, and the
    // consumer-side admission it enables in `lib/session-pr-links.test.ts`.
    [
      "set marker without array",
      {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      },
    ],
  ])("fails closed for %s metadata", async (_label, metadata) => {
    const base = row({ id: `invalid-${_label}` });
    base.artifact.sourceLinks = [cohortPrLink(metadata)];
    const result = await computeCohortPerformance(
      makeFakeDb({ cohortRows: [base] }),
      ORG,
      [base.artifactId],
      { cohortSampled: false }
    );

    expect(result.successRate).toBe(0);
    expect(result.mergedPrs).toBe(0);
  });

  it("counts a link carrying more refs than the retired read bound (ISS-8064)", async () => {
    // Previously in the fail-closed table above: the persisted read schema's
    // `.max(500)` made an over-bound link parse Invalid, so a session's merged
    // PRs silently left the cohort population and the success rate read 0%
    // rather than the truth.
    const base = row({ id: "over-retired-read-bound" });
    base.artifact.sourceLinks = [
      cohortPrLink({
        linkKind: SessionArtifactLinkKind.SessionPr,
        prRefs: Array.from({ length: 501 }, (_, index) => ({
          repositoryFullName: "acme/repo",
          prNumber: index + 1,
          relationTypes: [SessionPrRelationType.Created],
        })),
      }),
    ];

    const result = await computeCohortPerformance(
      makeFakeDb({ cohortRows: [base] }),
      ORG,
      [base.artifactId],
      { cohortSampled: false }
    );

    expect(result.successRate).toBe(100);
    expect(result.mergedPrs).toBe(1);
  });

  it.each([true, false])(
    "excludes an unverified current=%s PR detail",
    async (isCurrent) => {
      const base = row({ id: `unverified-${isCurrent}` });
      base.artifact.sourceLinks = [
        cohortPrLink(
          {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            linkKinds: [SessionArtifactLinkKind.SessionPrSet],
            prRefs: [
              {
                repositoryFullName: "acme/repo",
                prNumber: 7,
                relationTypes: [SessionPrRelationType.Created],
              },
            ],
          },
          { isCurrent, lastVerifiedAt: undefined }
        ),
      ];
      const result = await computeCohortPerformance(
        makeFakeDb({ cohortRows: [base] }),
        ORG,
        [base.artifactId],
        { cohortSampled: false }
      );

      expect(result.successRate).toBe(0);
      expect(result.mergedPrs).toBe(0);
    }
  );

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
    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });
    // KLOC/$ 2 vs 1 → +100%.
    expect(result.locDelta).toBeCloseTo(100);
    // tokens/KLOC 1000 vs 2000 → 50% more efficient.
    expect(result.tokenEfficiencyDelta).toBeCloseTo(50);
  });

  it("excludes the scanned cohort from the baseline and signs both deltas", async () => {
    const sessionQueries: FakeSessionQuery[] = [];
    const db = makeFakeDb({
      cohortRows: [
        row({
          id: "s1",
          mergedPrs: [{ repo: "acme/repo", number: 1 }],
        }),
        row({
          id: "s2",
          mergedPrs: [{ repo: "acme/repo", number: 2 }],
        }),
      ],
      baselineRows: [
        row({
          id: "b1",
          mergedPrs: [{ repo: "acme/repo", number: 3 }],
        }),
        row({ id: "b2", mergedPrs: [] }),
      ],
      sessionQueries,
    });

    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });

    const baselineQueries = sessionQueries.filter(
      (query) => query.where.artifactId?.notIn !== undefined
    );
    expect(baselineQueries).toHaveLength(1);
    expect(baselineQueries[0]?.where.artifactId?.notIn).toEqual(["s1", "s2"]);
    // Cohort 2/2 merged vs. baseline 1/2 → +50 points, not -50.
    expect(result.successDelta).toBe(50);
    // Mean judge score 9 vs. 6 → +50%, not -33%.
    expect(result.qualityDelta).toBeNull();
  });

  // ISS-9853 locking tests: the two baseline-read shapes the cohort walk must
  // NOT move. Stryker (2026-09-11, 76.32% on this file) reported the window's
  // min/max and the sample's `orderBy`/`take` as surviving mutants — nothing
  // pinned them — so they are pinned here before the walk lands.
  it("bounds the baseline window by the cohort's earliest and latest start", async () => {
    const sessionQueries: FakeSessionQuery[] = [];
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", startedAt: 5000 }),
        row({ id: "s2", startedAt: 1000 }),
        row({ id: "s3", startedAt: 9000 }),
      ],
      sessionQueries,
    });

    await computeCohortPerformance(db, ORG, ["s1", "s2", "s3"], {
      cohortSampled: false,
    });

    const [baselineQuery] = sessionQueries.filter(
      (query) => query.where.artifactId?.notIn !== undefined
    );
    expect(baselineQuery?.where.sessionStartedAt).toEqual({
      gte: new Date(1000),
      lte: new Date(9000),
    });
  });

  it("samples the baseline comparator from the most recent sessions, capped", async () => {
    const sessionQueries: FakeSessionQuery[] = [];
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1" })],
      sessionQueries,
    });

    await computeCohortPerformance(db, ORG, ["s1"], { cohortSampled: false });

    const [baselineQuery] = sessionQueries.filter(
      (query) => query.where.artifactId?.notIn !== undefined
    );
    expect(baselineQuery?.orderBy).toEqual({ sessionStartedAt: "desc" });
    // RULING 4 (ISS-9853): the comparator is a deliberate 500-row sample, kept.
    expect(baselineQuery?.take).toBe(500);
  });

  it("keeps another org's sessions out of the baseline", async () => {
    const db = makeFakeDb({
      cohortRows: [
        row({
          id: "s1",
          mergedPrs: [{ repo: "acme/repo", number: 1 }],
        }),
        row({
          id: "s2",
          mergedPrs: [{ repo: "acme/repo", number: 2 }],
        }),
      ],
      baselineRows: [
        row({
          id: "b1",
          mergedPrs: [{ repo: "acme/repo", number: 3 }],
        }),
        row({ id: "b2", mergedPrs: [] }),
      ],
      // Another tenant's sessions sit in the same window. The baseline read is
      // `notIn`-scoped, not id-scoped, so only its org predicate holds them out.
      foreignBaselineRows: [
        row({
          id: "f1",
          mergedPrs: [{ repo: "other/repo", number: 9 }],
        }),
        row({
          id: "f2",
          mergedPrs: [{ repo: "other/repo", number: 10 }],
        }),
      ],
    });

    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });

    // Own-org baseline only: 1/2 merged and a mean score of 6 → +50 on both.
    // Leaking the foreign rows in gives 3/4 merged and mean 7.5 → +25 and +20.
    expect(result.successDelta).toBe(50);
    expect(result.qualityDelta).toBeNull();
  });

  it("dedups branch-fallback LOC per branch in the baseline (FEA-3633)", async () => {
    // Baseline non-fallback LOC = 0; the fallback LOC lives entirely on ONE branch
    // shared by many sessions → MAX(added+removed) = 2000 counted ONCE, NOT
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
      fallbackGroups: [{ loc: 2000 }],
    });
    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });
    expect(result.locDelta).toBeCloseTo(100);
  });

  it("keeps LOC deltas when the fallback baseline exactly reaches the branch cap", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 10_000, cost: 10, tokens: 4000 })],
      baselineSum: {
        linesAdded: 0,
        linesRemoved: 0,
        estimatedCost: 10,
        inputTokens: 2000n,
        outputTokens: 2000n,
      },
      fallbackGroups: Array.from({ length: 5000 }, () => ({ loc: 1 })),
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    expect(result.locDelta).toBeCloseTo(100);
  });

  it("nulls the deltas when the baseline is empty (no fabrication)", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1", loc: 4000, cost: 2, tokens: 4000 })],
      // baselineSum defaults to all-null (no baseline sessions).
    });
    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });
    expect(result.locDelta).toBeNull();
    expect(result.tokenEfficiencyDelta).toBeNull();
    // Absolute cohort success rate is still real (0 here — no PRs).
    expect(result.successRate).toBe(0);
  });

  it("leaves quality null and reads no judge scores (ISS-12435: Loops removed)", async () => {
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1" })],
    });
    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });
    expect(result.qualityScore).toBeNull();
    expect(result.qualityDelta).toBeNull();
    expect(db.judgeScore.aggregate).not.toHaveBeenCalled();
  });

  it("produces an efficiency trend sparkline from cohort timing", async () => {
    const db = makeFakeDb({
      cohortRows: [
        row({ id: "s1", loc: 1000, tokens: 1000, startedAt: 0 }),
        row({ id: "s2", loc: 2000, tokens: 1000, startedAt: 1000 }),
      ],
    });
    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });
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
    const result = await computeCohortPerformance(db, ORG, ["s1", "s2"], {
      cohortSampled: false,
    });
    // Two distinct PRs (keyed by branch id), not one `acme/repo#null` bucket.
    expect(result.mergedPrs).toBe(2);
    expect(result.successRate).toBe(100);
  });
});
