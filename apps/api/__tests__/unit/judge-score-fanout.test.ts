/**
 * Unit tests for fanOutJudgeScores.
 *
 * Verifies that JudgeScore rows are constructed correctly and written via
 * tx.judgeScore.createMany, including promptId lookup from prompt_registry.
 */
import { vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  PromptType: {
    JUDGE: "JUDGE",
  },
}));

import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { EvalStatus } from "@repo/api/src/types/evaluation";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import { buildCaseScore } from "../fixtures/evaluation";

// ---------------------------------------------------------------------------
// Mock tx factory
// ---------------------------------------------------------------------------

function createMockTx() {
  return {
    prompt: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    judgeScore: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const EVALUATION_ID = "eval-aaaaaaaa-0000-7000-8000-000000000001";
const ORG_ID = "org-aaaaaaaa-0000-7000-8000-000000000002";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fanOutJudgeScores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps promptId from normalized judge name and falls back to null when not found", async () => {
    const caseScoreA = buildCaseScore("clarity-judge", 0.9);
    const caseScoreB = buildCaseScore("brevity-judge", 0.75);

    const report: JudgesReport = {
      report_id: "r1",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [caseScoreA, caseScoreB],
    };

    const tx = createMockTx();
    tx.prompt.findMany.mockResolvedValue([
      { id: "prompt-clarity-v3", name: "clarity_judge", version: 3 },
    ]);

    await fanOutJudgeScores({
      evaluationId: EVALUATION_ID,
      organizationId: ORG_ID,
      report,
      tx: tx as any,
    });

    expect(tx.prompt.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        promptType: "JUDGE",
      },
      distinct: ["name"],
      orderBy: [{ version: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        version: true,
      },
    });

    expect(tx.judgeScore.createMany).toHaveBeenCalledOnce();

    const [call] = tx.judgeScore.createMany.mock.calls;
    const { data } = call[0];

    expect(data).toHaveLength(2);

    const metricA = caseScoreA.metrics[0];
    expect(data[0]).toEqual({
      evaluationId: EVALUATION_ID,
      promptId: "prompt-clarity-v3",
      caseId: caseScoreA.case_id,
      threshold: metricA.threshold,
      score: metricA.score,
      justification: metricA.justification,
      finalStatus: caseScoreA.final_status,
    });

    const metricB = caseScoreB.metrics[0];
    expect(data[1]).toEqual({
      evaluationId: EVALUATION_ID,
      promptId: null,
      caseId: caseScoreB.case_id,
      threshold: metricB.threshold,
      score: metricB.score,
      justification: metricB.justification,
      finalStatus: caseScoreB.final_status,
    });
  });

  it("uses the first prompt per normalized stem from pre-sorted query results", async () => {
    const report: JudgesReport = {
      report_id: "r-stem",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [buildCaseScore("clarity-judge", 0.9)],
    };

    const tx = createMockTx();
    tx.prompt.findMany.mockResolvedValue([
      { id: "prompt-clarity-v4", name: "clarity_judge", version: 4 },
      { id: "prompt-clarity-v2", name: "clarity-score", version: 2 },
      { id: "prompt-clarity-v1", name: "clarity-judge", version: 1 },
    ]);

    await fanOutJudgeScores({
      evaluationId: EVALUATION_ID,
      organizationId: ORG_ID,
      report,
      tx: tx as any,
    });

    const [call] = tx.judgeScore.createMany.mock.calls;
    const { data } = call[0];

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      caseId: "clarity-judge",
      promptId: "prompt-clarity-v4",
    });
  });

  it("calls createMany with skipDuplicates: true", async () => {
    const report: JudgesReport = {
      report_id: "r1",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [buildCaseScore("dry-judge", 0.85)],
    };

    const tx = createMockTx();

    await fanOutJudgeScores({
      evaluationId: EVALUATION_ID,
      organizationId: ORG_ID,
      report,
      tx: tx as any,
    });

    expect(tx.judgeScore.createMany).toHaveBeenCalledOnce();
    const [call] = tx.judgeScore.createMany.mock.calls;
    expect(call[0]).toMatchObject({ skipDuplicates: true });
  });

  it("does not call createMany when report.stats is empty", async () => {
    const report: JudgesReport = {
      report_id: "r-empty",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [],
    };

    const tx = createMockTx();

    await fanOutJudgeScores({
      evaluationId: EVALUATION_ID,
      organizationId: ORG_ID,
      report,
      tx: tx as any,
    });

    expect(tx.judgeScore.createMany).not.toHaveBeenCalled();
  });

  it("does not crash and skips row when caseScore.metrics is empty", async () => {
    const report: JudgesReport = {
      report_id: "r-no-metrics",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "empty-metrics-judge",
          final_status: EvalStatus.Passed,
          metrics: [],
        },
      ],
    };

    const tx = createMockTx();

    await expect(
      fanOutJudgeScores({
        evaluationId: EVALUATION_ID,
        organizationId: ORG_ID,
        report,
        tx: tx as any,
      })
    ).resolves.toBeUndefined();

    expect(tx.judgeScore.createMany).not.toHaveBeenCalled();
  });

  it("does not call createMany when all caseScores have empty metrics", async () => {
    const report: JudgesReport = {
      report_id: "r-all-empty",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "judge-alpha",
          final_status: EvalStatus.Failed,
          metrics: [],
        },
        {
          type: "case_score",
          case_id: "judge-beta",
          final_status: EvalStatus.NeedsImprovement,
          metrics: [],
        },
      ],
    };

    const tx = createMockTx();

    await fanOutJudgeScores({
      evaluationId: EVALUATION_ID,
      organizationId: ORG_ID,
      report,
      tx: tx as any,
    });

    expect(tx.judgeScore.createMany).not.toHaveBeenCalled();
  });
});
