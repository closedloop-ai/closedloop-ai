// Evaluation types for judge scoring and feedback visualization.
// These types match the simplified JSON schema for judges.json output.
//
// @see https://linear.app/closedloop-ai/issue/AI-252

/**
 * Evaluation status const object persisted as enum values:
 * - FAILED
 * - NEEDS_IMPROVEMENT
 * - PASSED
 */
export const EvalStatus = {
  Failed: "FAILED",
  NeedsImprovement: "NEEDS_IMPROVEMENT",
  Passed: "PASSED",
} as const;

export type EvalStatus = (typeof EvalStatus)[keyof typeof EvalStatus];

/**
 * Evaluation report type discriminator persisted with DocumentEvaluation rows.
 */
export const EvaluationReportType = {
  Plan: "PLAN",
  Code: "CODE",
  Prd: "PRD",
  Feature: "FEATURE",
} as const;

export type EvaluationReportType =
  (typeof EvaluationReportType)[keyof typeof EvaluationReportType];

/** Canonical tuple of allowed evaluation report type values. */
export const EVALUATION_REPORT_TYPE_OPTIONS = [
  EvaluationReportType.Plan,
  EvaluationReportType.Code,
  EvaluationReportType.Prd,
  EvaluationReportType.Feature,
] as const;

/**
 * Canonical `ISSUE` input alias for the persisted `FEATURE` evaluation report
 * type (FEA-3956, PRD-560 Phase 3). Parallels `ArtifactSubtypeAlias.Issue` and
 * `DocumentTypeAlias.Issue`: the product renamed Features → Issues, but the
 * persisted evaluation discriminator stays `FEATURE`. A skewed newer client
 * that emits the canonical `ISSUE` report type normalizes to the persisted
 * `FEATURE` via {@link normalizeEvaluationReportType}; `ISSUE` never persists.
 * Additive and skew-safe.
 */
export const EvaluationReportTypeAlias = {
  Issue: "ISSUE",
} as const;
export type EvaluationReportTypeAlias =
  (typeof EvaluationReportTypeAlias)[keyof typeof EvaluationReportTypeAlias];

/**
 * The accepted *input* evaluation-report-type vocabulary: every persisted
 * {@link EvaluationReportType} plus the `ISSUE` alias (FEA-3956). Boundary
 * consumers accept this superset; the value is normalized to a persisted
 * {@link EvaluationReportType} with {@link normalizeEvaluationReportType}.
 */
export const EvaluationReportTypeInput = {
  ...EvaluationReportType,
  ...EvaluationReportTypeAlias,
} as const;
export type EvaluationReportTypeInput =
  (typeof EvaluationReportTypeInput)[keyof typeof EvaluationReportTypeInput];

/**
 * Accepted *input* tuple for report-type query validation: the canonical
 * {@link EVALUATION_REPORT_TYPE_OPTIONS} plus the `ISSUE` alias (FEA-3956).
 * Boundary validators (e.g. judges-analytics) accept this superset and then
 * normalize with {@link normalizeEvaluationReportType} so a skewed newer client
 * sending `ISSUE` queries the persisted `FEATURE` evaluations instead of 400ing.
 */
export const EVALUATION_REPORT_TYPE_INPUT_OPTIONS = [
  ...EVALUATION_REPORT_TYPE_OPTIONS,
  EvaluationReportTypeAlias.Issue,
] as const;

/**
 * Maps every accepted input evaluation report type
 * ({@link EvaluationReportTypeInput}) to the persisted
 * {@link EvaluationReportType}. Only the `ISSUE` alias is remapped (→
 * `FEATURE`); every canonical value maps to itself. Exhaustive `Record` so the
 * compiler forces a mapping decision when a new input value is added (FEA-3956).
 */
export const EVALUATION_REPORT_TYPE_INPUT_TO_CANONICAL: Record<
  EvaluationReportTypeInput,
  EvaluationReportType
> = {
  [EvaluationReportType.Plan]: EvaluationReportType.Plan,
  [EvaluationReportType.Code]: EvaluationReportType.Code,
  [EvaluationReportType.Prd]: EvaluationReportType.Prd,
  [EvaluationReportType.Feature]: EvaluationReportType.Feature,
  // FEA-3956: the canonical `ISSUE` report type resolves to persisted `FEATURE`.
  [EvaluationReportTypeAlias.Issue]: EvaluationReportType.Feature,
};

/**
 * Normalizes an accepted input evaluation report type to its persisted
 * {@link EvaluationReportType}. `ISSUE` → `FEATURE`; every other value is
 * returned unchanged (FEA-3956).
 */
export function normalizeEvaluationReportType(
  reportType: EvaluationReportTypeInput
): EvaluationReportType {
  return EVALUATION_REPORT_TYPE_INPUT_TO_CANONICAL[reportType];
}

/** Statistics for a single metric produced by a judge run. */
export type MetricStatistics = {
  metric_name: string;
  threshold: number;
  score: number;
  justification: string;
};

/** Per-case metric statistics report (individual judge result). */
export type CaseScore = {
  type: "case_score";
  case_id: string;
  final_status: EvalStatus;
  metrics: MetricStatistics[];
};

/** Top-level judges report structure matching the judges.json output schema. */
export type JudgesReport = {
  report_id: string;
  timestamp: string;
  stats: CaseScore[];
};

/**
 * Single judge's feedback item in API responses.
 * Normalized from JudgeScore rows for use in judges feedback endpoints.
 */
export type JudgeFeedbackItem = {
  judgeScoreId: string;
  caseId: string;
  score: number;
  threshold: number;
  justification: string;
  finalStatus: EvalStatus;
  promptName: string | null;
  metricName: string;
  /**
   * ISO-8601 creation time of the owning `ArtifactEvaluation`. Optional and
   * additive: producers that don't populate it degrade to the legacy
   * non-empty-array freshness check. The feature-judges refetch uses it to tell
   * a just-completed run's feedback apart from a prior run's stale scores
   * returned during the ingestion gap (FEA-3899).
   */
  evaluationCreatedAt?: string;
};

/**
 * API response wrapper for judges feedback.
 * Returns normalized JudgeScore rows as JudgeFeedbackItem array on success,
 * or null if no evaluation found, or error details on failure.
 */
export type JudgesFeedbackResponse =
  | { status: "success"; data: JudgeFeedbackItem[] }
  | { status: "not_found"; data: null }
  | { status: "error"; error: string };

/**
 * Per-entity judge scores keyed by report type.
 * Each key corresponds to one EvaluationReportType value; null means no
 * evaluation of that type exists for the entity.
 */
export type DocumentJudgeScores = Record<
  EvaluationReportType,
  JudgeFeedbackItem[] | null
>;

/**
 * Batch response mapping entity IDs to their latest judge feedback items,
 * separated by report type.
 * The map key is entityId (equals documentId for all existing DOCUMENT-type
 * rows, so callers are unaffected by this naming).
 * Used by the documents table to show inline judge scores.
 */
export type BatchJudgeScoresResponse = Record<string, DocumentJudgeScores>;
