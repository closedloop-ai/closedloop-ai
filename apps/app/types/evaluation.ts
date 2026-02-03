/**
 * Evaluation types for judge scoring and feedback visualization.
 * These types match the JSON schema defined in PRD AI-216.
 *
 * @see https://linear.app/closedloop-ai/issue/AI-216/view-evaluation-results-us-001
 */

/**
 * Evaluation status enum representing the 3-point scale:
 * - 1 = Poor (needs attention)
 * - 2 = Needs Improvement
 * - 3 = Great
 */
export type EvalStatus = 1 | 2 | 3;

/**
 * Statistics for a single metric across all invocations.
 *
 * Attributes:
 * - metric_name: Name of the metric (judge display name)
 * - mean: Mean score across all invocations
 * - std_dev: Standard deviation of scores
 * - min: Minimum score observed
 * - max: Maximum score observed
 * - pass_rate: Percentage of invocations that passed threshold (0.0-1.0)
 * - threshold: Pass/fail threshold for this metric (null if not defined)
 * - sample_count: Number of invocations evaluated
 * - scores: Raw scores for debugging and further analysis
 * - justification: Optional list of individual justifications for the metric score
 */
export type MetricStatistics = {
  metric_name: string;
  mean: number;
  std_dev: number;
  min: number;
  max: number;
  pass_rate: number;
  threshold: number | null;
  sample_count: number;
  scores: number[];
  justification: string[] | null;
};

/**
 * Per-case metric statistics report.
 *
 * Attributes:
 * - weighted_score: Weighted average score across all metrics
 * - metrics: Array of metric statistics for this case
 * - type: Discriminator field (always "case_score")
 * - case_id: Unique identifier for the evaluation case
 * - eval_set_id: Identifier for the evaluation set
 * - final_status: Final evaluation status for this case
 */
export type CaseScore = {
  weighted_score: number;
  metrics: MetricStatistics[];
  type: "case_score";
  case_id: string;
  eval_set_id: string;
  final_status: EvalStatus;
};
