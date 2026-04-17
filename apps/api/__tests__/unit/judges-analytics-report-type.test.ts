import { DocumentType } from "@repo/api/src/types/document";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { judgesAnalyticsService } from "@/app/judges-analytics/service";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  PromptType: { JUDGE: "JUDGE" },
  EntityType: { DOCUMENT: "DOCUMENT" },
}));

describe("judgesAnalyticsService reportType scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters aggregate stats query by evaluation.reportType", async () => {
    const judgeScoreFindMany = vi.fn().mockResolvedValue([]);
    const mockDb = {
      prompt: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      judgeScore: { findMany: judgeScoreFindMany },
      document: {
        findMany: vi.fn().mockResolvedValue([]),
      },
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
    expect(judgeScoreFindMany).toHaveBeenCalledOnce();
    const [call] = judgeScoreFindMany.mock.calls;
    expect(call[0].where.evaluation.reportType).toBe(EvaluationReportType.Code);
  });

  it("maps judge descriptions from latest prompt version", async () => {
    const mockDb = {
      prompt: {
        findMany: vi.fn().mockResolvedValue([
          {
            name: "clarity-judge",
            description: "Old clarity description",
            version: 1,
          },
          {
            name: "clarity-judge",
            description: "Latest clarity description",
            version: 2,
          },
        ]),
      },
      judgeScore: {
        findMany: vi.fn().mockResolvedValue([
          {
            caseId: "clarity-judge",
            metricName: "clarity-judge",
            promptId: null,
            score: 0.8,
            evaluation: {
              documentId: "artifact-1",
              entityId: "artifact-1",
            },
          },
          {
            caseId: "unknown-judge",
            metricName: "unknown-judge",
            promptId: null,
            score: 0.7,
            evaluation: {
              documentId: "artifact-1",
              entityId: "artifact-1",
            },
          },
        ]),
      },
      document: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "artifact-1", type: DocumentType.ImplementationPlan },
          ]),
      },
      documentRating: {
        findMany: vi.fn().mockResolvedValue([]),
      },
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

  it("filters judge detail query by evaluation.reportType", async () => {
    const judgeScoreFindMany = vi.fn().mockResolvedValue([]);
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
      judgeScore: { findMany: judgeScoreFindMany },
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
    expect(judgeScoreFindMany).toHaveBeenCalledOnce();
    const [call] = judgeScoreFindMany.mock.calls;
    expect(call[0].where.evaluation.reportType).toBe(EvaluationReportType.Plan);
  });

  it("keeps prompt route identity separate from metric display in collision rows", async () => {
    const mockDb = {
      prompt: {
        findMany: vi
          .fn()
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
          .mockResolvedValueOnce([
            {
              id: "prompt-1",
              description: "Judge alpha description",
            },
            {
              id: "prompt-2",
              description: "Judge beta description",
            },
          ]),
      },
      judgeScore: {
        findMany: vi.fn().mockResolvedValue([
          {
            caseId: "judge-alpha",
            metricName: "clarity",
            promptId: "prompt-1",
            score: 0.8,
            evaluation: {
              documentId: "artifact-1",
              entityId: "artifact-1",
            },
          },
          {
            caseId: "judge-beta",
            metricName: "clarity",
            promptId: "prompt-2",
            score: 0.7,
            evaluation: {
              documentId: "artifact-2",
              entityId: "artifact-2",
            },
          },
        ]),
      },
      document: {
        findMany: vi.fn().mockResolvedValue([
          { id: "artifact-1", type: DocumentType.ImplementationPlan },
          { id: "artifact-2", type: DocumentType.ImplementationPlan },
        ]),
      },
      documentRating: {
        findMany: vi.fn().mockResolvedValue([]),
      },
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

  it("queries scores by resolved prompt IDs instead of metricName", async () => {
    const judgeScoreFindMany = vi.fn().mockResolvedValue([]);
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
      judgeScore: { findMany: judgeScoreFindMany },
      document: {
        findMany: vi.fn().mockResolvedValue([]),
      },
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

    expect(judgeScoreFindMany).toHaveBeenCalledOnce();
    const [findManyCall] = judgeScoreFindMany.mock.calls;
    expect(findManyCall[0].where.promptId).toEqual({
      in: ["prompt-1", "prompt-2"],
    });
    expect(findManyCall[0].where.metricName).toBeUndefined();
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
