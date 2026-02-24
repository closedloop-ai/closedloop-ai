import type {
  CaseScore,
  EvaluationReportType,
  JudgesReport,
  MetricStatistics,
} from "@repo/api/src/types/evaluation";
import {
  EvalStatus,
  EvaluationReportType as EvaluationReportTypeValue,
} from "@repo/api/src/types/evaluation";

/** Regex pattern to match and remove the "-judge" suffix from case IDs. */
const JUDGE_SUFFIX_PATTERN = /-judge$/;

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

/**
 * Builds a CaseScore with a realistic metric_name derived from case_id.
 *
 * Derivation: `caseId.toLowerCase().replace(/-judge$/, "").replaceAll("-", "_") + "_score"`
 *
 * Examples:
 * - "clarity-judge" → "clarity_score"
 * - "test-case" → "test_case_score"
 *
 * @param caseId - The case identifier (must not be empty)
 * @param score - The numeric score value
 * @param extraMetrics - Additional metrics to include
 * @throws {Error} If caseId is empty
 */
export function buildCaseScore(
  caseId: string,
  score: number,
  extraMetrics: MetricStatistics[] = []
): CaseScore {
  if (!caseId) {
    throw new Error("caseId must not be empty");
  }

  const metricName = `${caseId
    .toLowerCase()
    .replace(JUDGE_SUFFIX_PATTERN, "")
    .replaceAll("-", "_")}_score`;

  return {
    type: "case_score",
    case_id: caseId,
    final_status: EvalStatus.Passed,
    metrics: [buildMetric({ metric_name: metricName, score }), ...extraMetrics],
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
  reportType?: EvaluationReportType;
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
    reportType: EvaluationReportTypeValue.Plan,
    reportId: "test-report",
    reportData: defaultReport,
    createdAt: new Date(),
    ...overrides,
  };
}
