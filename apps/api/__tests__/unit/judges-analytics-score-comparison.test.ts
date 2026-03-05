/**
 * Unit tests for judgesAnalyticsService.getJudgeScores.
 *
 * Tests concurrence default (no human ratings → avgUserRating = judgeScore, delta = 0),
 * average computation, delta, sort order, coverage, and pagination.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  PromptType: { JUDGE: "JUDGE" },
}));

import { judgesAnalyticsService } from "@/app/judges-analytics/service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = "org-test";

function makeJudgeScoreRow(
  id: string,
  score: number,
  humanScores: number[] = []
) {
  return {
    id: `js-${id}`,
    score,
    createdAt: new Date("2026-01-15T00:00:00Z"),
    evaluation: {
      artifactId: id,
      artifact: {
        id,
        type: ArtifactType.ImplementationPlan,
        title: `Artifact ${id}`,
        slug: id,
      },
    },
    judgeHumanScores: humanScores.map((s) => ({ score: s })),
  };
}

function mockDb(
  promptNames: string[],
  judgeScores: ReturnType<typeof makeJudgeScoreRow>[]
) {
  const db = {
    prompt: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          promptNames.map((name, i) => ({ id: `prompt-${i}`, name }))
        ),
    },
    judgeScore: {
      findMany: vi.fn().mockResolvedValue(judgeScores),
    },
  };
  mockWithDbCall(db);
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("judgesAnalyticsService.getJudgeScores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no prompts match the promptName", async () => {
    mockDb([], []);

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
    mockDb(["clarity_judge"], []);

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result).toEqual({
      rows: [],
      totalArtifacts: 0,
      ratedArtifacts: 0,
      coveragePct: 0,
      pagination: { page: 1, pageSize: 20, totalRows: 0, totalPages: 0 },
    });
  });

  it("applies concurrence default when no human ratings (avgUserRating = judgeScore, delta = 0)", async () => {
    mockDb(["clarity_judge"], [makeJudgeScoreRow("a1", 0.85)]);

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.rows).toHaveLength(1);
    expect(result?.rows[0]).toMatchObject({
      artifactId: "a1",
      judgeScore: 0.85,
      avgUserRating: 0.85,
      userRatingCount: 0,
      delta: 0,
    });
  });

  it("computes average and delta when a single human rating exists", async () => {
    mockDb(["clarity_judge"], [makeJudgeScoreRow("a1", 0.8, [0.5])]);

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

  it("computes mean correctly across multiple human ratings", async () => {
    mockDb(["clarity_judge"], [makeJudgeScoreRow("a1", 0.9, [0.6, 0.4, 0.8])]);

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

  it("sorts rows: delta DESC then judgeScore DESC (delta=0 rows last)", async () => {
    mockDb(
      ["clarity_judge"],
      [
        makeJudgeScoreRow("unrated-hi", 0.9), // delta=0
        makeJudgeScoreRow("high-delta", 0.8, [0.2]), // delta=0.6
        makeJudgeScoreRow("low-delta", 0.7, [0.5]), // delta=0.2
        makeJudgeScoreRow("unrated-lo", 0.6), // delta=0
      ]
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    const ids = result?.rows.map((r) => r.artifactId);
    // high-delta (0.6) first, low-delta (0.2) second, then unrated by judgeScore DESC
    expect(ids).toEqual([
      "high-delta",
      "low-delta",
      "unrated-hi",
      "unrated-lo",
    ]);
  });

  it("computes coverage percentage: ratedArtifacts / totalArtifacts * 100", async () => {
    mockDb(
      ["clarity_judge"],
      [
        makeJudgeScoreRow("a1", 0.8, [0.7]), // rated
        makeJudgeScoreRow("a2", 0.7, [0.9]), // rated
        makeJudgeScoreRow("a3", 0.9, []), // unrated
        makeJudgeScoreRow("a4", 0.6, []), // unrated
      ]
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.totalArtifacts).toBe(4);
    expect(result?.ratedArtifacts).toBe(2);
    expect(result?.coveragePct).toBe(50); // 2/4 * 100
  });

  it("returns 0 coverage when all artifacts are unrated", async () => {
    mockDb(
      ["clarity_judge"],
      [makeJudgeScoreRow("a1", 0.8), makeJudgeScoreRow("a2", 0.7)]
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.ratedArtifacts).toBe(0);
    expect(result?.coveragePct).toBe(0);
  });

  it("paginates to the correct page slice", async () => {
    mockDb(
      ["clarity_judge"],
      ["a1", "a2", "a3", "a4", "a5"].map((id) => makeJudgeScoreRow(id, 0.5))
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

  it("includes evaluatedAt ISO string from createdAt", async () => {
    const evaluatedAt = new Date("2026-03-01T12:00:00.000Z");
    const db = {
      prompt: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "prompt-clarity", name: "clarity_judge" }]),
      },
      judgeScore: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "js-1",
            score: 0.7,
            createdAt: evaluatedAt,
            evaluation: {
              artifactId: "a1",
              artifact: {
                id: "a1",
                type: ArtifactType.ImplementationPlan,
                title: "A1",
                slug: "a1",
              },
            },
            judgeHumanScores: [],
          },
        ]),
      },
    };
    mockWithDbCall(db);

    const result = await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    expect(result?.rows[0]).toMatchObject({
      artifactId: "a1",
      artifactType: ArtifactType.ImplementationPlan,
      evaluatedAt: "2026-03-01T12:00:00.000Z",
    });
  });

  it("filters judge scores by promptId (relational)", async () => {
    const db = {
      prompt: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "prompt-clarity", name: "clarity_judge" }]),
      },
      judgeScore: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDbCall(db);

    await judgesAnalyticsService.getJudgeScores(
      ORG_ID,
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    const judgeScoreFindManyCall = db.judgeScore.findMany.mock.calls[0][0];
    const promptIds: string[] = judgeScoreFindManyCall.where.promptId.in;

    expect(promptIds).toContain("prompt-clarity");
    expect(judgeScoreFindManyCall.where.caseId).toBeUndefined();
  });
});
