/**
 * Report-type scoping + description/collision mapping for the judges-analytics
 * service after the FEA-2809/FEA-2742 DB-pushdown.
 *
 * `getAggregateStats` and `getJudgeDetail` now aggregate DB-side via `$queryRaw`
 * (power sums), and `getJudgeScores` pages via `$queryRaw`. The mocks below feed
 * the raw-query shapes and assert the reconstructed output + scoping.
 */
import { DocumentType } from "@repo/api/src/types/document";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { judgesAnalyticsService } from "@/app/judges-analytics/service";

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

/** Power-sum group row (getAggregateJudgeScoreGroups shape). */
function groupRow(overrides: {
  caseId: string;
  metricName: string;
  promptId: string | null;
  subtype?: string;
  scores: number[];
  documentIds: string[];
}) {
  const scores = overrides.scores;
  const count = scores.length;
  const sum = scores.reduce((a, b) => a + b, 0);
  const sumSq = scores.reduce((a, b) => a + b * b, 0);
  return {
    caseId: overrides.caseId,
    metricName: overrides.metricName,
    promptId: overrides.promptId,
    subtype: overrides.subtype ?? DocumentType.ImplementationPlan,
    count,
    sum,
    sumSq,
    min: Math.min(...scores),
    max: Math.max(...scores),
    documentIds: overrides.documentIds,
  };
}

describe("judgesAnalyticsService reportType scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters the aggregate query by reportType and returns its groups", async () => {
    // $queryRaw calls: [0] description lookup, [1] aggregate groups.
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const mockDb = {
      prompt: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      artifactRating: { findMany: vi.fn().mockResolvedValue([]) },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    };

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(
          mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
        )
      )
    );

    const result = await judgesAnalyticsService.getAggregateStats(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      EvaluationReportType.Code
    );

    expect(result.reportType).toBe(EvaluationReportType.Code);
    const aggregateCall = queryRaw.mock.calls[1][0] as { values: unknown[] };
    expect(aggregateCall.values).toContain(EvaluationReportType.Code);
  });

  it("maps judge descriptions from latest prompt version", async () => {
    const queryRaw = vi
      .fn()
      // getJudgeDescriptionByPromptName (DISTINCT ON latest per name)
      .mockResolvedValueOnce([
        {
          name: "clarity-judge",
          description: "Latest clarity description",
          version: 2,
        },
      ])
      // getAggregateJudgeScoreGroups
      .mockResolvedValueOnce([
        groupRow({
          caseId: "clarity-judge",
          metricName: "clarity-judge",
          promptId: null,
          scores: [0.8],
          documentIds: ["artifact-1"],
        }),
        groupRow({
          caseId: "unknown-judge",
          metricName: "unknown-judge",
          promptId: null,
          scores: [0.7],
          documentIds: ["artifact-1"],
        }),
      ]);
    const mockDb = {
      prompt: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      artifactRating: { findMany: vi.fn().mockResolvedValue([]) },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    };

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(
          mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
        )
      )
    );

    const result = await judgesAnalyticsService.getAggregateStats(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      EvaluationReportType.Plan
    );

    const judges = result.groups[0]?.judges ?? [];
    const clarityJudge = judges.find(
      (judge) => judge.judgeName === "clarity-judge"
    );
    const unknownJudge = judges.find(
      (judge) => judge.judgeName === "unknown-judge"
    );

    expect(clarityJudge?.description).toBe("Latest clarity description");
    expect(unknownJudge?.description).toBeNull();
  });

  it("filters the judge-detail query by reportType", async () => {
    // getJudgeDetail: prompt.findMany resolves versions, then a single
    // $queryRaw returns per-promptId power moments (empty here).
    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    const mockDb = {
      prompt: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "prompt-1",
            name: "clarity-judge",
            version: 1,
            content: "prompt text",
            createdAt: new Date("2026-01-10"),
          },
        ]),
      },
      $queryRaw: queryRaw,
    };

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(
          mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
        )
      )
    );

    const result = await judgesAnalyticsService.getJudgeDetail(
      "org-1",
      "clarity",
      EvaluationReportType.Plan
    );

    expect(result?.judge.reportType).toBe(EvaluationReportType.Plan);
    expect(queryRaw).toHaveBeenCalledOnce();
    const detailCall = queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(detailCall.values).toContain(EvaluationReportType.Plan);
  });

  it("keeps prompt route identity separate from metric display in collision rows", async () => {
    const queryRaw = vi
      .fn()
      // getJudgeDescriptionByPromptName
      .mockResolvedValueOnce([
        {
          name: "judge-alpha",
          description: "Judge alpha description",
          version: 1,
        },
        {
          name: "judge-beta",
          description: "Judge beta description",
          version: 1,
        },
      ])
      // getAggregateJudgeScoreGroups — same metricName from two promptIds =
      // collision, so keys disambiguate by route name.
      .mockResolvedValueOnce([
        groupRow({
          caseId: "judge-alpha",
          metricName: "clarity",
          promptId: "prompt-1",
          scores: [0.8],
          documentIds: ["artifact-1"],
        }),
        groupRow({
          caseId: "judge-beta",
          metricName: "clarity",
          promptId: "prompt-2",
          scores: [0.7],
          documentIds: ["artifact-2"],
        }),
      ]);
    const mockDb = {
      prompt: {
        // buildMetricNameDescriptionMap: descriptionById lookup by promptId.
        findMany: vi.fn().mockResolvedValue([
          { id: "prompt-1", description: "Judge alpha description" },
          { id: "prompt-2", description: "Judge beta description" },
        ]),
      },
      $queryRaw: queryRaw,
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      artifactRating: { findMany: vi.fn().mockResolvedValue([]) },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    };

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(
          mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
        )
      )
    );

    const result = await judgesAnalyticsService.getAggregateStats(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      EvaluationReportType.Plan
    );

    const judges = result.groups[0]?.judges ?? [];
    expect(judges).toHaveLength(2);
    expect(judges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          judgeName: "judge_alpha-clarity",
          promptName: "judge_alpha",
          metricName: "clarity",
          displayMetricName: "judge_alpha-clarity",
        }),
        expect.objectContaining({
          judgeName: "judge_beta-clarity",
          promptName: "judge_beta",
          metricName: "clarity",
          displayMetricName: "judge_beta-clarity",
        }),
      ])
    );
  });

  it("pages judge scores by resolved prompt IDs via the raw page query", async () => {
    // getJudgeScores: prompt.findMany resolves two versions, then $queryRaw
    // (page query, then totals fallback since the page is empty).
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ totalRows: 0, ratedRows: 0 }]);
    const mockDb = {
      prompt: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "prompt-1",
            name: "clarity-judge",
            version: 2,
            content: "v2",
            createdAt: new Date("2026-01-11"),
          },
          {
            id: "prompt-2",
            name: "clarity-judge",
            version: 1,
            content: "v1",
            createdAt: new Date("2026-01-10"),
          },
        ]),
      },
      $queryRaw: queryRaw,
    };

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(
          mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
        )
      )
    );

    const result = await judgesAnalyticsService.getJudgeScores(
      "org-1",
      "clarity",
      EvaluationReportType.Plan,
      1,
      20
    );

    const pageCall = queryRaw.mock.calls[0][0] as { values: unknown[] };
    const flatValues = JSON.stringify(pageCall.values);
    expect(flatValues).toContain("prompt-1");
    expect(flatValues).toContain("prompt-2");
    expect(result).toEqual(
      expect.objectContaining({
        rows: [],
        totalDocuments: 0,
        ratedDocuments: 0,
        coveragePct: 0,
      })
    );
  });
});
