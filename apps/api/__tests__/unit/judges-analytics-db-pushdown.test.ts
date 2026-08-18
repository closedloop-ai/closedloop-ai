/**
 * FEA-2809 + FEA-2742 — proves the judges-analytics aggregation, moment
 * computation, delta ranking and pagination are pushed to the database and that
 * the app reconstructs the SAME statistics from bounded DB-side power sums that
 * the old full-population in-app reduction produced.
 *
 * Strategy: feed the raw-query mocks the exact power sums a known score
 * population would yield, then assert the reconstructed mean / stdDev / radar
 * axes match the array-based reference helpers (which remain the oracle). Also
 * asserts the fetches are bounded — a LIMIT/OFFSET (getJudgeScores) and grouped
 * power sums (getAggregateStats/getJudgeDetail), never a raw per-score fetch.
 */
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { withDb } from "@repo/database";
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

import { DocumentType } from "@repo/api/src/types/document";
import {
  computeBimodalityCoefficient,
  computeCertaintyFraction,
  computeMean,
  computeStdDev,
  judgesAnalyticsService,
} from "@/app/judges-analytics/service";

// Power sums for a known score population (the DB would compute these).
function powerSums(scores: number[]) {
  return {
    count: scores.length,
    sum: scores.reduce((a, b) => a + b, 0),
    sumSq: scores.reduce((a, b) => a + b * b, 0),
    sum3: scores.reduce((a, b) => a + b ** 3, 0),
    sum4: scores.reduce((a, b) => a + b ** 4, 0),
    min: Math.min(...scores),
    max: Math.max(...scores),
    extremeCount: scores.filter((v) => v > 0.7 || v < 0.3).length,
  };
}

describe("getAggregateStats — DB power-sum reconstruction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reconstructs mean/min/max/stdDev exactly from grouped power sums", async () => {
    const scores = [0.2, 0.4, 0.6, 0.8, 0.9];
    const s = powerSums(scores);

    const queryRaw = vi
      .fn()
      // getJudgeDescriptionByPromptName
      .mockResolvedValueOnce([])
      // getAggregateJudgeScoreGroups — one group carrying the power sums
      .mockResolvedValueOnce([
        {
          caseId: "clarity-judge",
          metricName: "clarity-judge",
          promptId: null,
          subtype: DocumentType.ImplementationPlan,
          count: s.count,
          sum: s.sum,
          sumSq: s.sumSq,
          min: s.min,
          max: s.max,
          documentIds: ["a1", "a2", "a3"],
        },
      ]);
    const db = {
      prompt: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      artifactRating: { findMany: vi.fn().mockResolvedValue([]) },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    };
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(
        cb(db as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
      )
    );

    const result = await judgesAnalyticsService.getAggregateStats(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      EvaluationReportType.Plan
    );

    const judge = result.groups[0].judges[0];
    const mean = computeMean(scores);
    expect(judge.mean).toBeCloseTo(mean, 12);
    expect(judge.min).toBe(Math.min(...scores));
    expect(judge.max).toBe(Math.max(...scores));
    expect(judge.stdDev).toBeCloseTo(computeStdDev(scores, mean), 12);
    expect(judge.documentsEvaluated).toBe(3); // distinct documentIds
  });

  it("combines multiple collision groups into the same key via summed power sums", async () => {
    // Two promptIds share metricName 'clarity' → collision → keys disambiguate,
    // and each key's stats come from its own group's power sums.
    const a = [0.5, 0.7, 0.9];
    const b = [0.1, 0.3];
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          caseId: "judge-alpha",
          metricName: "clarity",
          promptId: "prompt-1",
          subtype: DocumentType.ImplementationPlan,
          ...powerSums(a),
          documentIds: ["a1"],
        },
        {
          caseId: "judge-beta",
          metricName: "clarity",
          promptId: "prompt-2",
          subtype: DocumentType.ImplementationPlan,
          ...powerSums(b),
          documentIds: ["a2"],
        },
      ]);
    const db = {
      prompt: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      artifactRating: { findMany: vi.fn().mockResolvedValue([]) },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    };
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(
        cb(db as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
      )
    );

    const result = await judgesAnalyticsService.getAggregateStats(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      EvaluationReportType.Plan
    );

    const judges = result.groups[0].judges;
    const alpha = judges.find((j) => j.judgeName === "judge_alpha-clarity");
    const beta = judges.find((j) => j.judgeName === "judge_beta-clarity");
    expect(alpha?.mean).toBeCloseTo(computeMean(a), 12);
    expect(beta?.mean).toBeCloseTo(computeMean(b), 12);
  });
});

describe("getJudgeDetail — DB power-moment reconstruction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reconstructs radar axes from per-promptId power moments (matches array oracle)", async () => {
    // ≥ minScoreCount (10) so radar axes are populated.
    const scores = [
      0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.05, 0.99,
    ];
    const s = powerSums(scores);

    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ promptId: "prompt-1", ...s }]);
    const db = {
      prompt: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "prompt-1",
            name: "clarity-judge",
            version: 1,
            content: "text",
            createdAt: new Date("2026-01-10"),
          },
        ]),
      },
      $queryRaw: queryRaw,
    };
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(
        cb(db as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
      )
    );

    const result = await judgesAnalyticsService.getJudgeDetail(
      "org-1",
      "clarity",
      EvaluationReportType.Plan
    );

    expect(result?.judge.scoreCount).toBe(scores.length);

    const mean = computeMean(scores);
    const stdDev = computeStdDev(scores, mean);
    const bimodality = computeBimodalityCoefficient(scores);
    const certainty = computeCertaintyFraction(scores);

    const axes = result?.judge.radarAxes;
    expect(axes).not.toBeNull();
    // optimism = mean, polarity = bimodality, certainty = certaintyFraction.
    expect(axes?.optimism).toBeCloseTo(mean, 10);
    expect(axes?.polarity).toBeCloseTo(bimodality, 10);
    expect(axes?.certainty).toBeCloseTo(certainty, 10);
    // stubbornness = 1 - clamp(stdDev / 0.5, 0, 1)
    expect(axes?.stubbornness).toBeCloseTo(1 - Math.min(stdDev / 0.5, 1), 10);

    // Per-version panel mirrors the same reconstruction.
    const version = result?.judge.promptVersions[0];
    expect(version?.scoreCount).toBe(scores.length);
    expect(version?.mean).toBeCloseTo(mean, 10);
    expect(version?.stdDev).toBeCloseTo(stdDev, 10);
    expect(version?.min).toBe(Math.min(...scores));
    expect(version?.max).toBe(Math.max(...scores));
  });

  it("issues a single grouped moment query (bounded, not a per-score fetch)", async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    const db = {
      prompt: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "prompt-1",
            name: "clarity-judge",
            version: 1,
            content: "text",
            createdAt: new Date("2026-01-10"),
          },
        ]),
      },
      $queryRaw: queryRaw,
    };
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(
        cb(db as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
      )
    );

    await judgesAnalyticsService.getJudgeDetail(
      "org-1",
      "clarity",
      EvaluationReportType.Plan
    );

    // Exactly one raw query, and it groups by prompt_id (no unbounded findMany).
    expect(queryRaw).toHaveBeenCalledOnce();
    const sqlText = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings
      .join(" ")
      .toLowerCase();
    expect(sqlText).toContain('group by js."prompt_id"');
    expect(sqlText).toContain("sum(js");
  });
});

describe("getJudgeScores — bounded LIMIT/OFFSET page fetch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits ORDER BY delta + LIMIT/OFFSET so the fetch is bounded to one page", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ totalRows: 0, ratedRows: 0 }]);
    const db = {
      prompt: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "prompt-1", name: "clarity_judge" }]),
      },
      $queryRaw: queryRaw,
    };
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(
        cb(db as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
      )
    );

    await judgesAnalyticsService.getJudgeScores(
      "org-1",
      "clarity",
      EvaluationReportType.Plan,
      3,
      25
    );

    const pageCall = queryRaw.mock.calls[0][0] as {
      strings: string[];
      values: unknown[];
    };
    const sqlText = pageCall.strings.join(" ").toLowerCase();
    expect(sqlText).toContain("order by");
    expect(sqlText).toContain('"delta" desc');
    expect(sqlText).toContain("limit");
    expect(sqlText).toContain("offset");
    // count(*) over() gives population totals without a full materialization.
    expect(sqlText).toContain("count(*) over ()");
    // LIMIT = pageSize (25), OFFSET = (3-1)*25 = 50.
    expect(pageCall.values).toContain(25);
    expect(pageCall.values).toContain(50);
  });
});
