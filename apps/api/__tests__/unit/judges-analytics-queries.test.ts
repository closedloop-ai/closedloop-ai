/**
 * Unit tests for judges-analytics service query structure.
 *
 * SS8.7 requirements:
 * 1. Judge score queries filter by evaluation.organizationId directly,
 *    NOT via evaluation.artifact.organizationId join.
 * 2. Multi-org isolation: scores from one org are not returned for another.
 */
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { judgesAnalyticsService } from "@/app/judges-analytics/service";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  PromptType: { JUDGE: "JUDGE" },
}));

const ORG_A = "org-alpha";
const START = new Date("2026-01-01");
const END = new Date("2026-01-31");

function makeDb(judgeScoreFindManyResult: unknown[] = []) {
  return {
    prompt: { findMany: vi.fn().mockResolvedValue([]) },
    judgeScore: {
      findMany: vi.fn().mockResolvedValue(judgeScoreFindManyResult),
    },
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
    artifactRating: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe("judgesAnalyticsService — query structure (SS8.7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("where clause uses evaluation.organizationId not evaluation.artifact.organizationId", async () => {
    const mockDb = makeDb();

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(
          mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
        )
      )
    );

    await judgesAnalyticsService.getAggregateStats(
      ORG_A,
      START,
      END,
      EvaluationReportType.Plan
    );

    const judgeScoreCalls = mockDb.judgeScore.findMany.mock.calls;
    expect(judgeScoreCalls.length).toBeGreaterThan(0);

    const [firstCall] = judgeScoreCalls;
    const where = firstCall[0].where;

    // Must scope via evaluation.organizationId directly
    expect(where.evaluation).toMatchObject({ organizationId: ORG_A });

    // Must NOT use nested artifact relation for org scoping
    expect(where.evaluation?.artifact).toBeUndefined();
  });

  it("scores from org-B are not returned when querying org-A", async () => {
    const orgAScore = {
      caseId: "clarity-judge",
      metricName: "clarity-judge",
      promptId: null,
      score: 0.9,
      evaluation: {
        artifactId: "artifact-a1",
        entityId: "artifact-a1",
        organizationId: ORG_A,
      },
    };

    // orgB score should never appear in orgA results because the query
    // filters by organizationId at the evaluation level
    const mockDb = makeDb([orgAScore]);
    const artifactFindMany = vi
      .fn()
      .mockResolvedValue([{ id: "artifact-a1", type: "IMPLEMENTATION_PLAN" }]);
    mockDb.artifact.findMany = artifactFindMany;

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(
          mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
        )
      )
    );

    await judgesAnalyticsService.getAggregateStats(
      ORG_A,
      START,
      END,
      EvaluationReportType.Plan
    );

    // Verify the DB query for judge scores was scoped to ORG_A only
    const [judgeScoreCall] = mockDb.judgeScore.findMany.mock.calls;
    expect(judgeScoreCall[0].where.evaluation.organizationId).toBe(ORG_A);

    // Verify the artifact lookup after score fetch is also scoped to ORG_A
    const artifactCalls = artifactFindMany.mock.calls;
    const entityLookupCall = artifactCalls.find((call: unknown[]) => {
      const arg = call[0] as { where?: { organizationId?: string } };
      return arg?.where?.organizationId === ORG_A;
    });
    expect(entityLookupCall).toBeDefined();
  });
});
