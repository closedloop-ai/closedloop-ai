import type {
  CaseScore,
  JudgesReport,
  MetricStatistics,
} from "@repo/api/src/types/evaluation";
import { EvalStatus } from "@repo/api/src/types/evaluation";

/** Builds a MetricStatistics entry for tests. */
export function buildMetric(
  overrides: Partial<MetricStatistics> & { metric_name: string; score: number }
): MetricStatistics {
  return {
    threshold: 0.8,
    justification: "auto-generated",
    ...overrides,
  };
}

/** Builds a CaseScore whose primary metric matches case_id (extractJudgeScores convention). */
export function buildCaseScore(
  caseId: string,
  score: number,
  extraMetrics: MetricStatistics[] = []
): CaseScore {
  return {
    type: "case_score",
    case_id: caseId,
    final_status: EvalStatus.Passed,
    metrics: [buildMetric({ metric_name: caseId, score }), ...extraMetrics],
  };
}

/**
 * Factory for creating mock ArtifactEvaluation DB row.
 * Used to mock Prisma database queries in tests.
 *
 * @param overrides - Optional overrides for fields
 */
export function createMockEvaluationRow(overrides?: {
  id?: string;
  artifactId?: string;
  actionRunId?: string;
  reportId?: string;
  reportData?: JudgesReport;
  createdAt?: Date;
}) {
  const defaultReport: JudgesReport = {
    report_id: "test-report",
    timestamp: new Date().toISOString(),
    stats: [],
  };

  return {
    id: "eval-123",
    artifactId: "artifact-123",
    actionRunId: "action-run-123",
    reportId: "test-report",
    reportData: defaultReport,
    createdAt: new Date(),
    ...overrides,
  };
}
