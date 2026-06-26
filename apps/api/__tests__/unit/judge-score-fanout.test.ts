/**
 * Unit tests for fanOutJudgeScores.
 *
 * Verifies that JudgeScore rows are constructed correctly and written via
 * tx.judgeScore.createMany, including promptId lookup from prompt_registry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLog = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  PromptType: {
    JUDGE: "JUDGE",
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: mockLog,
}));

import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { EvalStatus } from "@repo/api/src/types/evaluation";
import { normalizeJudgeName } from "@/lib/judge-name-utils";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import { buildCaseScore, buildMetric } from "../fixtures/evaluation";

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
      metricName: normalizeJudgeName(metricA.metric_name),
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
      metricName: normalizeJudgeName(metricB.metric_name),
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
    // Match Prisma DISTINCT ON ordering: ORDER BY name ASC, version DESC per distinct name
    tx.prompt.findMany.mockResolvedValue([
      { id: "prompt-clarity-v1", name: "clarity-judge", version: 1 },
      { id: "prompt-clarity-v2", name: "clarity-score", version: 2 },
      { id: "prompt-clarity-v4", name: "clarity_judge", version: 4 },
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

  // -------------------------------------------------------------------------
  // Multi-metric fan-out
  // -------------------------------------------------------------------------

  it("creates one JudgeScore row per metric in the CaseScore", async () => {
    const report: JudgesReport = {
      report_id: "r-multi",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "clarity-judge",
          final_status: EvalStatus.Passed,
          metrics: [
            buildMetric({ metric_name: "clarity_score", score: 0.9 }),
            buildMetric({ metric_name: "brevity_score", score: 0.7 }),
            buildMetric({ metric_name: "accuracy_score", score: 0.85 }),
          ],
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

    const [call] = tx.judgeScore.createMany.mock.calls;
    const { data } = call[0];

    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({
      caseId: "clarity-judge",
      metricName: "clarity",
      score: 0.9,
    });
    expect(data[1]).toMatchObject({
      caseId: "clarity-judge",
      metricName: "brevity",
      score: 0.7,
    });
    expect(data[2]).toMatchObject({
      caseId: "clarity-judge",
      metricName: "accuracy",
      score: 0.85,
    });
  });

  it("produces sum of all metrics across all cases", async () => {
    const report: JudgesReport = {
      report_id: "r-multi-cases",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "judge-alpha",
          final_status: EvalStatus.Passed,
          metrics: [
            buildMetric({ metric_name: "metric_a", score: 0.9 }),
            buildMetric({ metric_name: "metric_b", score: 0.8 }),
          ],
        },
        {
          type: "case_score",
          case_id: "judge-beta",
          final_status: EvalStatus.NeedsImprovement,
          metrics: [buildMetric({ metric_name: "metric_c", score: 0.5 })],
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

    const [call] = tx.judgeScore.createMany.mock.calls;
    const { data } = call[0];

    expect(data).toHaveLength(3); // 2 + 1
    expect(data.map((r: { metricName: string }) => r.metricName)).toEqual([
      "metric_a",
      "metric_b",
      "metric_c",
    ]);
  });

  // -------------------------------------------------------------------------
  // Prompt collision — highest version wins, warning logged
  // -------------------------------------------------------------------------

  it("logs collision warning when multiple prompt names normalize to same key", async () => {
    const report: JudgesReport = {
      report_id: "r-collision",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [buildCaseScore("clarity-judge", 0.9)],
    };

    const tx = createMockTx();
    tx.prompt.findMany.mockResolvedValue([
      { id: "prompt-v1", name: "clarity-judge", version: 1 },
      { id: "prompt-v2", name: "clarity-score", version: 2 },
      { id: "prompt-v4", name: "clarity_judge", version: 4 },
    ]);

    await fanOutJudgeScores({
      evaluationId: EVALUATION_ID,
      organizationId: ORG_ID,
      report,
      tx: tx as any,
    });

    // Highest version wins
    const [call] = tx.judgeScore.createMany.mock.calls;
    expect(call[0].data[0]).toMatchObject({
      promptId: "prompt-v4",
    });

    // Collision warning logged
    expect(mockLog.warn).toHaveBeenCalledWith(
      "judge_prompt_name_collision",
      expect.objectContaining({
        normalizedName: "clarity",
        collidingNames: expect.arrayContaining(["clarity-judge"]),
        selected: "clarity_judge",
      })
    );
  });

  // -------------------------------------------------------------------------
  // Bug 3: Prompt unmatched — promptId is null, structured log emitted
  // -------------------------------------------------------------------------

  it("logs structured warning when no prompt matches a case", async () => {
    const report: JudgesReport = {
      report_id: "r-unmatched",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [buildCaseScore("orphan-judge", 0.8)],
    };

    const tx = createMockTx();
    // No prompts returned — no matches possible
    tx.prompt.findMany.mockResolvedValue([]);

    await fanOutJudgeScores({
      evaluationId: EVALUATION_ID,
      organizationId: ORG_ID,
      report,
      tx: tx as any,
    });

    const [call] = tx.judgeScore.createMany.mock.calls;
    expect(call[0].data[0]).toMatchObject({
      promptId: null,
    });

    expect(mockLog.warn).toHaveBeenCalledWith(
      "judge_prompt_id_unmatched",
      expect.objectContaining({
        caseId: "orphan-judge",
        organizationId: ORG_ID,
        event: "prompt_id_unmatched",
      })
    );
  });

  it("maps numeric final_status values (1/2/3) to EvalStatus strings", async () => {
    const report = {
      report_id: "r-numeric-status",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "judge-passed",
          final_status: 1,
          metrics: [
            buildMetric({ metric_name: "judge_passed_score", score: 0.95 }),
          ],
        },
        {
          type: "case_score",
          case_id: "judge-needs-improvement",
          final_status: 2,
          metrics: [
            buildMetric({
              metric_name: "judge_needs_improvement_score",
              score: 0.65,
            }),
          ],
        },
        {
          type: "case_score",
          case_id: "judge-failed",
          final_status: 3,
          metrics: [
            buildMetric({ metric_name: "judge_failed_score", score: 0.2 }),
          ],
        },
      ],
    } as unknown as JudgesReport;

    const tx = createMockTx();

    await fanOutJudgeScores({
      evaluationId: EVALUATION_ID,
      organizationId: ORG_ID,
      report,
      tx: tx as any,
    });

    const [call] = tx.judgeScore.createMany.mock.calls;
    const { data } = call[0];

    expect(data).toHaveLength(3);
    expect(data.map((row: { finalStatus: string }) => row.finalStatus)).toEqual(
      [EvalStatus.Passed, EvalStatus.NeedsImprovement, EvalStatus.Failed]
    );
  });

  it("preserves canonical string final_status values", async () => {
    const report = {
      report_id: "r-string-status",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "judge-a",
          final_status: "PASSED",
          metrics: [buildMetric({ metric_name: "judge_a_score", score: 0.9 })],
        },
        {
          type: "case_score",
          case_id: "judge-b",
          final_status: "NEEDS_IMPROVEMENT",
          metrics: [buildMetric({ metric_name: "judge_b_score", score: 0.55 })],
        },
        {
          type: "case_score",
          case_id: "judge-c",
          final_status: "FAILED",
          metrics: [buildMetric({ metric_name: "judge_c_score", score: 0.25 })],
        },
      ],
    } as unknown as JudgesReport;

    const tx = createMockTx();

    await fanOutJudgeScores({
      evaluationId: EVALUATION_ID,
      organizationId: ORG_ID,
      report,
      tx: tx as any,
    });

    const [call] = tx.judgeScore.createMany.mock.calls;
    const { data } = call[0];

    expect(data.map((row: { finalStatus: string }) => row.finalStatus)).toEqual(
      [EvalStatus.Passed, EvalStatus.NeedsImprovement, EvalStatus.Failed]
    );
  });

  it("skips rows with invalid final_status and logs warning", async () => {
    const report = {
      report_id: "r-invalid-status",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "judge-valid",
          final_status: 1,
          metrics: [
            buildMetric({ metric_name: "judge_valid_score", score: 0.9 }),
          ],
        },
        {
          type: "case_score",
          case_id: "judge-invalid",
          final_status: 999,
          metrics: [
            buildMetric({ metric_name: "judge_invalid_score", score: 0.1 }),
          ],
        },
      ],
    } as unknown as JudgesReport;

    const tx = createMockTx();

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
      caseId: "judge-valid",
      finalStatus: EvalStatus.Passed,
    });
    expect(mockLog.warn).toHaveBeenCalledWith(
      "judge_final_status_invalid",
      expect.objectContaining({
        caseId: "judge-invalid",
        rawFinalStatus: 999,
      })
    );
  });

  // -------------------------------------------------------------------------
  // Transaction rollback: createMany failure propagates
  // -------------------------------------------------------------------------

  it("propagates error when createMany throws (transaction rollback)", async () => {
    const report: JudgesReport = {
      report_id: "r-fail",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [buildCaseScore("fail-judge", 0.5)],
    };

    const tx = createMockTx();
    tx.judgeScore.createMany.mockRejectedValue(
      new Error("Simulated DB failure")
    );

    await expect(
      fanOutJudgeScores({
        evaluationId: EVALUATION_ID,
        organizationId: ORG_ID,
        report,
        tx: tx as any,
      })
    ).rejects.toThrow("Simulated DB failure");
  });
});
