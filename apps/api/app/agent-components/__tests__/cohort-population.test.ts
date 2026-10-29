/**
 * @file cohort-population.test.ts
 * @description ISS-9853 — what `computeCohortPerformance` now measures its
 * metrics OVER.
 *
 * The sibling `cohort-performance.test.ts` owns the pure math and the
 * per-metric behaviour that predates this ticket. These are the population
 * cases: the walk that replaced the 2,000-session slice, the caller attestation
 * that says whether the ids it walked were themselves a sample, the two
 * fail-closed branches that decline to build a biased baseline, and the
 * comparator-sample disclosure. Split out because the original file reached the
 * 1,000-line ceiling.
 */
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
  type FakeSessionQuery,
  makeFakeDb,
  ORG,
  row,
} from "@/__tests__/support/agent-components/cohort-performance.test-db";
import { SESSION_CANDIDATE_CHUNK_SIZE } from "@/app/agent-sessions/service/session-candidate-stream";
import {
  BASELINE_SAMPLE_CAP,
  computeCohortPerformance,
} from "../cohort-performance";

describe("computeCohortPerformance — the population it measures", () => {
  beforeEach(() => vi.clearAllMocks());

  // ISS-9853 replaces three cap-era cases here. Their expectations changed
  // because the behaviour they pinned was the defect: a 2,001-session cohort
  // used to lose every delta and publish a 2,000-session prefix as its
  // `successRate`. The walk covers all 2,001, so the deltas are real; what is
  // still disclosed is a cohort the CALLER sampled, which the cap could never
  // tell apart from a cohort it merely bounded.
  it("computes over every cohort session past the retired 2,000 scan cap", async () => {
    const sessionQueries: FakeSessionQuery[] = [];
    const ids = Array.from({ length: 2001 }, (_, i) => sessionId(i));
    const db = makeFakeDb({
      cohortRows: [
        row({ id: sessionId(0), loc: 4000, cost: 2, tokens: 4000 }),
        row({
          id: sessionId(2000),
          mergedPrs: [{ repo: "acme/repo", number: 1 }],
        }),
      ],
      baselineSum: {
        linesAdded: 2000,
        linesRemoved: 0,
        estimatedCost: 2,
        inputTokens: 2000n,
        outputTokens: 2000n,
      },
      baselineCostCoverage: { rowCount: 1, pricedRows: 1 },
      sessionQueries,
    });

    const result = await computeCohortPerformance(db, ORG, ids, {
      cohortSampled: false,
    });

    // The merged PR sits at index 2000 — the first id the retired slice DROPPED.
    expect(result.mergedPrs).toBe(1);
    expect(result.successRate).toBe(50);
    // Deltas are computed, because the baseline can exclude the whole cohort.
    expect(result.locDelta).not.toBeNull();
    expect(result.mergedPrsTruncated).toBe(false);
    const baselineQuery = sessionQueries.find(
      (query) => query.where.artifactId?.notIn !== undefined
    );
    expect(baselineQuery?.where.artifactId?.notIn).toHaveLength(ids.length);
  });

  // ISS-9853: the cap is gone, so `mergedPrsTruncated` can no longer be derived
  // from an id count. It is the CALLER's attestation that its id set was a
  // bounded sample of the cohort (the detail path's usage lane hit its `take`),
  // and it must not change any figure — only what the card may claim.
  it("declares a sampled cohort without changing what it measured", async () => {
    const sessionQueries: FakeSessionQuery[] = [];
    const ids = Array.from({ length: 2001 }, (_, i) => sessionId(i));
    const cohortRows = [
      row({ id: sessionId(0), loc: 4000, cost: 2, tokens: 4000 }),
      row({
        id: sessionId(2000),
        mergedPrs: [{ repo: "acme/repo", number: 1 }],
      }),
    ];
    const baselineSum = {
      linesAdded: 2000,
      linesRemoved: 0,
      estimatedCost: 2,
      inputTokens: 2000n,
      outputTokens: 2000n,
    };

    const whole = await computeCohortPerformance(
      makeFakeDb({ cohortRows, baselineSum }),
      ORG,
      ids,
      { cohortSampled: false }
    );
    const db = makeFakeDb({ cohortRows, baselineSum, sessionQueries });
    const sampled = await computeCohortPerformance(db, ORG, ids, {
      cohortSampled: true,
    });

    expect(sampled.mergedPrsTruncated).toBe(true);
    // Absolutes are over the same walked rows either way.
    expect(sampled.successRate).toBe(whole.successRate);
    expect(sampled.mergedPrs).toBe(whole.mergedPrs);
    // But a `notIn` of a SAMPLE would count the unsampled cohort sessions as
    // baseline sessions, biasing every delta — so no baseline is read at all.
    expect(
      sessionQueries.filter(
        (query) => query.where.artifactId?.notIn !== undefined
      )
    ).toHaveLength(0);
    expect(db.sessionDetail.aggregate).not.toHaveBeenCalled();
    expect(sampled.locDelta).toBeNull();
    expect(sampled.successDelta).toBeNull();
    expect(sampled.tokenEfficiencyDelta).toBeNull();
    expect(sampled.qualityDelta).toBeNull();
    expect(sampled.baselineSampleSize).toBeNull();
  });

  it("carries the sampled declaration onto a cohort whose ids match no rows", async () => {
    const result = await computeCohortPerformance(
      makeFakeDb({ cohortRows: [] }),
      ORG,
      ["s1"],
      { cohortSampled: true }
    );

    // Nothing to measure, but the ids were still a sample: folding this to
    // `false` would let the card claim whole-cohort coverage over a prefix.
    expect(result.mergedPrs).toBeNull();
    expect(result.mergedPrsTruncated).toBe(true);
  });

  it("walks a cohort wider than one chunk, covering every id exactly once", async () => {
    const cohortChunkReads: string[][] = [];
    const ids = Array.from(
      { length: SESSION_CANDIDATE_CHUNK_SIZE + 1 },
      (_, i) => sessionId(i)
    );
    // One merged PR on each side of the chunk boundary, both on the SAME PR:
    // a walk that read a chunk twice would still count it once, but a walk that
    // dropped the second chunk would miss the session behind it.
    const db = makeFakeDb({
      cohortRows: [
        row({
          id: sessionId(0),
          mergedPrs: [{ repo: "acme/repo", number: 7 }],
        }),
        row({
          id: sessionId(SESSION_CANDIDATE_CHUNK_SIZE),
          mergedPrs: [{ repo: "acme/repo", number: 7 }],
        }),
      ],
      cohortChunkReads,
    });

    const result = await computeCohortPerformance(db, ORG, ids, {
      cohortSampled: false,
    });

    expect(cohortChunkReads).toHaveLength(2);
    for (const chunk of cohortChunkReads) {
      expect(chunk.length).toBeLessThanOrEqual(SESSION_CANDIDATE_CHUNK_SIZE);
    }
    const walked = cohortChunkReads.flat();
    expect(walked).toHaveLength(ids.length);
    expect(new Set(walked).size).toBe(ids.length);
    // The same PR from two sessions in two chunks is ONE distinct merged PR,
    // and both sessions count toward the rate.
    expect(result.mergedPrs).toBe(1);
    expect(result.successRate).toBe(100);
  });

  it("rejects the whole read when a later chunk fails, emitting no partial metrics", async () => {
    const ids = Array.from(
      { length: SESSION_CANDIDATE_CHUNK_SIZE + 1 },
      (_, i) => sessionId(i)
    );
    const db = makeFakeDb({
      cohortRows: [row({ id: sessionId(0) })],
      rejectCohortChunkAfter: 1,
    });

    // The cohort lane was never fail-open (only the LOC/cost enrichment is), and
    // a half-walked cohort would publish a prefix as the population — the exact
    // defect the cap removal exists to close.
    await expect(
      computeCohortPerformance(db, ORG, ids, { cohortSampled: false })
    ).rejects.toThrow("cohort chunk read failed");
  });

  it("skips the baseline and nulls every delta past the bind-parameter ceiling", async () => {
    const sessionQueries: FakeSessionQuery[] = [];
    // Wide enough that the whole-cohort `notIn` cannot be built. The baseline
    // fails CLOSED rather than excluding a subset of the cohort.
    const ids = Array.from({ length: 40_000 }, (_, i) => sessionId(i));
    const db = makeFakeDb({
      cohortRows: [
        row({
          id: sessionId(0),
          loc: 4000,
          cost: 2,
          tokens: 4000,
          mergedPrs: [{ repo: "acme/repo", number: 1 }],
        }),
      ],
      baselineSum: {
        linesAdded: 2000,
        linesRemoved: 0,
        estimatedCost: 2,
        inputTokens: 2000n,
        outputTokens: 2000n,
      },
      sessionQueries,
    });

    const result = await computeCohortPerformance(db, ORG, ids, {
      cohortSampled: false,
    });

    expect(
      sessionQueries.filter(
        (query) => query.where.artifactId?.notIn !== undefined
      )
    ).toHaveLength(0);
    expect(result.locDelta).toBeNull();
    expect(result.successDelta).toBeNull();
    expect(result.baselineSampleSize).toBeNull();
    // The absolute figures still describe every walked session.
    expect(result.successRate).toBe(100);
    expect(result.mergedPrs).toBe(1);
  });

  it.each([
    // Two sampled rows against a three-row window: the DISCLOSURE is the
    // sample's size, not the window's.
    ["a sample smaller than the window", 2, 3, 2],
    ["a sample covering the whole window", 2, 2, null],
    // The sample read and the window `_count` are two READ COMMITTED
    // statements. A count taken BEFORE a baseline session lands reads equal to
    // a sample that then filled the cap, so a cap-filling sample is disclosed
    // on its own evidence rather than trusting the count (whitlockk, #7103).
    [
      "a sample that filled the cap beside an equal count",
      BASELINE_SAMPLE_CAP,
      BASELINE_SAMPLE_CAP,
      BASELINE_SAMPLE_CAP,
    ],
  ])(
    "discloses %s as baselineSampleSize %s",
    async (_label, sampleRowCount, windowRowCount, expected) => {
      const db = makeFakeDb({
        cohortRows: [row({ id: "s1" })],
        baselineRows: Array.from({ length: sampleRowCount }, (_, i) =>
          row({ id: `b${i}` })
        ),
        baselineSum: {
          linesAdded: 10,
          linesRemoved: 0,
          estimatedCost: 1,
          inputTokens: 1n,
          outputTokens: 1n,
        },
        baselineCostCoverage: {
          rowCount: windowRowCount,
          pricedRows: windowRowCount,
        },
      });

      const result = await computeCohortPerformance(db, ORG, ["s1"], {
        cohortSampled: false,
      });

      expect(result.baselineSampleSize).toBe(expected);
    }
  );

  it("declares no sample when the comparator read returned nothing", async () => {
    // The sample read and the window `_count` are two statements on two
    // snapshots: an empty sample beside a nonzero count is that race, not a
    // sample of zero sessions, and "sampled from 0" would be a false claim.
    const db = makeFakeDb({
      cohortRows: [row({ id: "s1" })],
      baselineRows: [],
      baselineSum: {
        linesAdded: 10,
        linesRemoved: 0,
        estimatedCost: 1,
        inputTokens: 1n,
        outputTokens: 1n,
      },
      baselineCostCoverage: { rowCount: 5, pricedRows: 5 },
    });

    const result = await computeCohortPerformance(db, ORG, ["s1"], {
      cohortSampled: false,
    });

    expect(result.baselineSampleSize).toBeNull();
  });
});

/** Zero-padded so a fixture's ids sort the same way Postgres orders the key. */
function sessionId(index: number): string {
  return `s${String(index).padStart(6, "0")}`;
}
