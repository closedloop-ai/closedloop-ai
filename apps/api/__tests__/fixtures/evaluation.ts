import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  type CaseScore,
  EvalStatus,
  type EvaluationReportType,
  EvaluationReportType as EvaluationReportTypeValue,
  type MetricStatistics,
} from "@repo/api/src/types/evaluation";
import { normalizeJudgeName } from "@/lib/judge-name-utils";

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

  const metricName = `${normalizeJudgeName(caseId)}_score`;

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
  entityId?: string;
  entityType?: ArtifactType;
  organizationId?: string;
  documentId?: string | null;
  reportType?: EvaluationReportType;
  reportId?: string;
  createdAt?: Date;
}) {
  const entityId = overrides?.entityId ?? "artifact-123";

  return {
    id: "eval-123",
    entityId,
    entityType: ArtifactType.Document,
    organizationId: "org-123",
    documentId: entityId,
    reportType: EvaluationReportTypeValue.Plan,
    reportId: "test-report",
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Factory for creating a mock JudgeScore DB row with optional prompt relation.
 * Used to mock Prisma judgeScore.findMany queries in tests.
 *
 * @param overrides - Optional overrides for fields
 */
export function createMockJudgeScoreRow(overrides?: {
  id?: string;
  evaluationId?: string;
  promptId?: string | null;
  caseId?: string;
  metricName?: string;
  threshold?: number;
  score?: number;
  justification?: string;
  finalStatus?: EvalStatus;
  createdAt?: Date;
  prompt?: { id: string; name: string } | null;
}) {
  return {
    id: "judge-score-123",
    evaluationId: "eval-123",
    promptId: null,
    caseId: "test-judge",
    metricName: "test-judge",
    threshold: 0.8,
    score: 0.92,
    justification: "Test justification",
    finalStatus: EvalStatus.Passed as EvalStatus,
    createdAt: new Date(),
    prompt: null,
    ...overrides,
  };
}
