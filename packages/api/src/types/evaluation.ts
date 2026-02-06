// Evaluation types for judge scoring and feedback visualization.
// These types match the simplified JSON schema for judges.json output.
//
// @see https://linear.app/closedloop-ai/issue/AI-252

/**
 * Evaluation status const object representing the 3-point scale:
 * - 1 = Failed (needs attention)
 * - 2 = Needs Improvement
 * - 3 = Passed
 */
export const EvalStatus = {
  Failed: 1,
  NeedsImprovement: 2,
  Passed: 3,
} as const;

export type EvalStatus = (typeof EvalStatus)[keyof typeof EvalStatus];

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
 * API response wrapper for judges feedback.
 * Returns the report, or null if judges.json not found, or error details if malformed.
 */
export type JudgesFeedbackResponse =
  | { status: "success"; data: JudgesReport }
  | { status: "not_found"; data: null }
  | { status: "error"; error: string };
