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
 * Evaluation report type discriminator persisted with ArtifactEvaluation rows.
 */
export const EvaluationReportType = {
  Plan: "PLAN",
  Code: "CODE",
} as const;

export type EvaluationReportType =
  (typeof EvaluationReportType)[keyof typeof EvaluationReportType];

/** Canonical tuple of allowed evaluation report type values. */
export const EVALUATION_REPORT_TYPE_OPTIONS = [
  EvaluationReportType.Plan,
  EvaluationReportType.Code,
] as const;

/**
 * Statistics for a single metric (judge score).
 *
 * Attributes:
 * - metric_name: Name of the metric (judge display name)
 * - threshold: Pass/fail threshold for this metric
 * - score: The actual score value
 * - justification: Explanation for the score
 */
export type MetricStatistics = {
  metric_name: string;
  threshold: number;
  score: number;
  justification: string;
};

/**
 * Per-case metric statistics report (individual judge result).
 *
 * Attributes:
 * - type: Discriminator field (always "case_score")
 * - case_id: Unique identifier for the evaluation case (judge name)
 * - final_status: Final evaluation status for this case
 * - metrics: Array of metric statistics for this case
 */
export type CaseScore = {
  type: "case_score";
  case_id: string;
  final_status: EvalStatus;
  metrics: MetricStatistics[];
};

/**
 * Top-level judges report structure.
 *
 * Attributes:
 * - report_id: Unique identifier for this report
 * - timestamp: ISO 8601 timestamp when the report was generated
 * - stats: Array of CaseScore entries (one per judge)
 */
export type JudgesReport = {
  report_id: string;
  timestamp: string;
  stats: CaseScore[];
};

/**
 * Single judge's feedback item in API responses.
 * Normalized from JudgeScore rows for use in judges feedback endpoints.
 *
 * Attributes:
 * - caseId: Judge identifier (maps to JudgeScore.caseId)
 * - score: The judge score value
 * - threshold: Pass/fail threshold
 * - justification: Explanation for the score
 * - finalStatus: Final evaluation status (FAILED | NEEDS_IMPROVEMENT | PASSED)
 * - promptName: Human-readable prompt name from the prompt registry, or null if not linked
 * - metricName: URL-safe metric name for navigation and grouping, or null if not linked
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
 * Batch response mapping artifact IDs to their latest PLAN judge feedback items.
 * Used by the artifacts table to show inline judge scores.
 */
export type BatchJudgeScoresResponse = Record<string, JudgeFeedbackItem[]>;
