import { ArtifactType } from "@repo/api/src/types/artifact";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { judgesAnalyticsService } from "@/app/judges-analytics/service";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  PromptType: { JUDGE: "JUDGE" },
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
            score: 0.8,
            evaluation: {
              artifactId: "artifact-1",
              artifact: { type: ArtifactType.ImplementationPlan },
            },
          },
          {
            caseId: "unknown-judge",
            score: 0.7,
            evaluation: {
              artifactId: "artifact-1",
              artifact: { type: ArtifactType.ImplementationPlan },
            },
          },
        ]),
      },
      artifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "artifact-1", type: ArtifactType.ImplementationPlan },
          ]),
      },
      artifactRating: {
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
});
