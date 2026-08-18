/**
 * Unit tests for judgesAnalyticsService.getJudgeScores.
 *
 * After FEA-2742 the paginated judge-score query, delta ranking, coverage
 * totals and LIMIT/OFFSET are pushed into a single `$queryRaw`. These tests
 * therefore mock the raw-query results (page rows carrying windowed totals, and
 * the fallback totals query) and assert the service maps them faithfully.
 */
import { DocumentType } from "@repo/api/src/types/document";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ join: values }),
  },
  PromptType: { JUDGE: "JUDGE" },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
}));

import { withDb } from "@repo/database";
import { judgesAnalyticsService } from "@/app/judges-analytics/service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = "org-test";

type PageRow = {
  judgeScoreId: string;
  metricName: string;
  documentId: string;
  subtype: string;
  documentTitle: string;
  documentSlug: string | null;
  judgeScore: number;
  avgUserRating: number;
  userRatingCount: number;
  delta: number;
  evaluatedAt: Date;
  totalRows: number;
  ratedRows: number;
};

/**
 * Build a page row from a small spec, computing avgUserRating/delta/counts the
 * same way the SQL does (concurrence default, delta = |avg - score|).
 */
function makePageRow(
  id: string,
  score: number,
  humanScores: number[],
  totals: { totalRows: number; ratedRows: number }
): PageRow {
  const userRatingCount = humanScores.length;
  const avgUserRating =
    userRatingCount > 0
      ? humanScores.reduce((a, b) => a + b, 0) / userRatingCount
      : score;
  const delta = userRatingCount > 0 ? Math.abs(avgUserRating - score) : 0;
  return {
    judgeScoreId: `js-${id}`,
    metricName: "clarity",
    documentId: id,
    subtype: DocumentType.ImplementationPlan,
    documentTitle: `Artifact ${id}`,
    documentSlug: id,
    judgeScore: score,
    avgUserRating,
    userRatingCount,
    delta,
    evaluatedAt: new Date("2026-01-15T00:00:00Z"),
    totalRows: totals.totalRows,
    ratedRows: totals.ratedRows,
  };
}

/**
 * Wire `withDb` so that `prompt.findMany` resolves the judge prompt(s) and
 * `$queryRaw` returns `pageRows` then `totalsRows` (the fallback totals query
 * is only hit when the page is empty).
 */
function mockDb(
  promptNames: string[],
  pageRows: PageRow[],
  totalsRows: { totalRows: number; ratedRows: number }[] = [],
  metricExistsInOrg = true
) {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce(pageRows)
    .mockResolvedValueOnce(totalsRows);
  const db = {
    prompt: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          metricExistsInOrg && promptNames.length > 0
            ? promptNames.map((name, i) => ({ id: `prompt-${i}`, name }))
            : []
        ),
    },
    $queryRaw: queryRaw,
  };
  vi.mocked(withDb).mockImplementation((callback) =>
    Promise.resolve(
      callback(db as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
    )
  );
  return { db, queryRaw };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("judgesAnalyticsService.getJudgeScores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when metricName does not exist in organization", async () => {
    mockDb([], [], [], false);

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result).toBeNull();
  });

  it("returns empty response when prompt matches but no judge scores exist", async () => {
    mockDb(["clarity_judge"], [], [{ totalRows: 0, ratedRows: 0 }]);

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result).toEqual({
      rows: [],
      totalDocuments: 0,
      ratedDocuments: 0,
      coveragePct: 0,
      pagination: { page: 1, pageSize: 20, totalRows: 0, totalPages: 0 },
    });
  });

  it("applies concurrence default when no human ratings (avgUserRating = judgeScore, delta = 0)", async () => {
    mockDb(
      ["clarity_judge"],
      [makePageRow("a1", 0.85, [], { totalRows: 1, ratedRows: 0 })]
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.rows).toHaveLength(1);
    expect(result?.rows[0]).toMatchObject({
      documentId: "a1",
      judgeScore: 0.85,
      avgUserRating: 0.85,
      userRatingCount: 0,
      delta: 0,
    });
  });

  it("maps average and delta when a single human rating exists", async () => {
    mockDb(
      ["clarity_judge"],
      [makePageRow("a1", 0.8, [0.5], { totalRows: 1, ratedRows: 1 })]
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.rows[0].avgUserRating).toBeCloseTo(0.5);
    expect(result?.rows[0].userRatingCount).toBe(1);
    expect(result?.rows[0].delta).toBeCloseTo(0.3); // |0.5 - 0.8|
  });

  it("maps mean correctly across multiple human ratings", async () => {
    mockDb(
      ["clarity_judge"],
      [makePageRow("a1", 0.9, [0.6, 0.4, 0.8], { totalRows: 1, ratedRows: 1 })]
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.rows[0].avgUserRating).toBeCloseTo(0.6); // (0.6 + 0.4 + 0.8) / 3
    expect(result?.rows[0].userRatingCount).toBe(3);
    expect(result?.rows[0].delta).toBeCloseTo(0.3); // |0.6 - 0.9|
  });

  it("preserves the DB delta-DESC / judgeScore-DESC ordering of page rows", async () => {
    // The SQL emits rows already ordered; the service must not re-sort them.
    const totals = { totalRows: 4, ratedRows: 2 };
    mockDb(
      ["clarity_judge"],
      [
        makePageRow("high-delta", 0.8, [0.2], totals), // delta=0.6
        makePageRow("low-delta", 0.7, [0.5], totals), // delta=0.2
        makePageRow("unrated-hi", 0.9, [], totals), // delta=0
        makePageRow("unrated-lo", 0.6, [], totals), // delta=0
      ]
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    const ids = result?.rows.map((r) => r.documentId);
    expect(ids).toEqual([
      "high-delta",
      "low-delta",
      "unrated-hi",
      "unrated-lo",
    ]);
  });

  it("derives coverage percentage from the windowed totals", async () => {
    const totals = { totalRows: 4, ratedRows: 2 };
    mockDb(
      ["clarity_judge"],
      [
        makePageRow("a1", 0.8, [0.7], totals),
        makePageRow("a2", 0.7, [0.9], totals),
        makePageRow("a3", 0.9, [], totals),
        makePageRow("a4", 0.6, [], totals),
      ]
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.totalDocuments).toBe(4);
    expect(result?.ratedDocuments).toBe(2);
    expect(result?.coveragePct).toBe(50); // 2/4 * 100
  });

  it("returns 0 coverage when all artifacts are unrated", async () => {
    const totals = { totalRows: 2, ratedRows: 0 };
    mockDb(
      ["clarity_judge"],
      [makePageRow("a1", 0.8, [], totals), makePageRow("a2", 0.7, [], totals)]
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.ratedDocuments).toBe(0);
    expect(result?.coveragePct).toBe(0);
  });

  it("reports pagination metadata from the windowed totalRows", async () => {
    // page 2 of pageSize 2 over a 5-row population.
    const totals = { totalRows: 5, ratedRows: 0 };
    mockDb(
      ["clarity_judge"],
      [makePageRow("a3", 0.5, [], totals), makePageRow("a4", 0.5, [], totals)]
    );

    const page2 = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      2,
      2
    );

    expect(page2?.rows).toHaveLength(2);
    expect(page2?.pagination).toEqual({
      page: 2,
      pageSize: 2,
      totalRows: 5,
      totalPages: 3,
    });
  });

  it("uses the totals fallback query when the requested page is empty", async () => {
    // Out-of-range page → empty page rows, totals come from the fallback query.
    mockDb(["clarity_judge"], [], [{ totalRows: 5, ratedRows: 3 }]);

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      99,
      2
    );

    expect(result?.rows).toEqual([]);
    expect(result?.totalDocuments).toBe(5);
    expect(result?.ratedDocuments).toBe(3);
    expect(result?.coveragePct).toBe(60);
    expect(result?.pagination).toEqual({
      page: 99,
      pageSize: 2,
      totalRows: 5,
      totalPages: 3,
    });
  });

  it("includes evaluatedAt ISO string from the row createdAt", async () => {
    const evaluatedAt = new Date("2026-03-01T12:00:00.000Z");
    const row = makePageRow("a1", 0.7, [], { totalRows: 1, ratedRows: 0 });
    row.evaluatedAt = evaluatedAt;
    mockDb(["clarity_judge"], [row]);

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.rows[0]).toMatchObject({
      documentId: "a1",
      documentType: DocumentType.ImplementationPlan,
      evaluatedAt: "2026-03-01T12:00:00.000Z",
    });
  });

  it("passes the resolved prompt IDs and LIMIT/OFFSET into the page query", async () => {
    const { queryRaw } = mockDb(
      ["clarity_judge"],
      [],
      [{ totalRows: 0, ratedRows: 0 }]
    );
    // Two versions of the same normalized judge name resolve to two promptIds.
    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback({
          prompt: {
            findMany: vi.fn().mockResolvedValue([
              { id: "prompt-1", name: "clarity_judge" },
              { id: "prompt-2", name: "clarity_judge" },
            ]),
          },
          $queryRaw: queryRaw,
        } as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
      )
    );

    await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      2,
      10
    );

    // The first $queryRaw call is the page query; its interpolated values carry
    // the promptId list, the org, the reportType, and LIMIT/OFFSET.
    const pageCall = queryRaw.mock.calls[0][0] as { values: unknown[] };
    const flatValues = JSON.stringify(pageCall.values);
    expect(flatValues).toContain("prompt-1");
    expect(flatValues).toContain("prompt-2");
    expect(pageCall.values).toContain(ORG_ID);
    expect(pageCall.values).toContain(EvaluationReportType.Plan);
    expect(pageCall.values).toContain(10); // LIMIT
    expect(pageCall.values).toContain(10); // OFFSET = (2-1)*10
  });
});
