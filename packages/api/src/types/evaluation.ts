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
