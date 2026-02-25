/**
 * Unit tests for fanOutJudgeScores.
 *
 * Verifies that JudgeScore rows are constructed correctly and written via
 * tx.judgeScore.createMany. The Prompt model does not exist yet (PR 1 not
 * merged), so promptId is always null.
 */
import { vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
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

  it("calls createMany with one row per CaseScore containing correct fields and promptId: null", async () => {
    const caseScoreA = buildCaseScore("clarity-judge", 0.9);
    const caseScoreB = buildCaseScore("brevity-judge", 0.75);

    const report: JudgesReport = {
      report_id: "r1",
      timestamp: "2026-02-25T00:00:00Z",
      stats: [caseScoreA, caseScoreB],
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
    const { data } = call[0];

    expect(data).toHaveLength(2);

    const metricA = caseScoreA.metrics[0];
    expect(data[0]).toEqual({
      evaluationId: EVALUATION_ID,
      promptId: null,
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
