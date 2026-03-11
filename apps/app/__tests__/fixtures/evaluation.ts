import {
  type CaseScore,
  EvalStatus,
  type JudgeFeedbackItem,
  type JudgesReport,
  type MetricStatistics,
} from "@repo/api/src/types/evaluation";

/**
 * Factory for creating mock MetricStatistics objects.
 * Use this across all test files that need metric test data.
 *
 * @param overrides - Optional overrides for fields
 */
export const createMockMetricStatistics = (
  overrides?: Partial<MetricStatistics>
): MetricStatistics => {
  return {
    metric_name: "test_score",
    threshold: 0.8,
    score: 0.92,
    justification: "Default test justification",
    ...overrides,
  };
};

/**
 * Simplified factory for creating mock MetricStatistics with positional arguments.
 * Use for tests that need quick metric creation with name and score.
 *
 * @param name - The metric name
 * @param score - The score value
 * @param overrides - Optional overrides for other fields
 */
export const createMockMetric = (
  name: string,
  score: number,
  overrides?: Partial<MetricStatistics>
): MetricStatistics => {
  return createMockMetricStatistics({
    metric_name: name,
    score,
    ...overrides,
  });
};

/**
 * Factory for creating mock CaseScore objects.
 * Use this across all test files that need evaluation test data.
 */
export const createMockCaseScore = (
  overrides?: Partial<CaseScore>
): CaseScore => ({
  type: "case_score",
  case_id: "test-judge",
  final_status: EvalStatus.Passed,
  metrics: [createMockMetricStatistics()],
  ...overrides,
});

/**
 * Factory for creating mock JudgesReport objects.
 * Use this across all test files that need judges report test data.
 */
export const createMockJudgesReport = (
  overrides?: Partial<JudgesReport>
): JudgesReport => ({
  report_id: "test-report",
  timestamp: new Date().toISOString(),
  stats: [createMockCaseScore()],
  ...overrides,
});

/**
 * Factory for creating mock JudgeFeedbackItem objects.
 * Use this for Option B response type test data.
 *
 * @param overrides - Optional overrides for fields
 */
export const createMockJudgeFeedbackItem = (
  overrides?: Partial<JudgeFeedbackItem>
): JudgeFeedbackItem => ({
  judgeScoreId: "js-00000000-0000-0000-0000-000000000001",
  caseId: "test-judge",
  metricName: "test-judge",
  score: 0.92,
  threshold: 0.8,
  justification: "Default test justification",
  finalStatus: EvalStatus.Passed,
  promptName: null,
  ...overrides,
});

/**
 * Helper to determine if a metric passes based on score >= threshold.
 */
export const doesMetricPass = (metric: MetricStatistics): boolean => {
  return metric.score >= metric.threshold;
};

/**
 * Helper to count passing metrics in a CaseScore.
 */
export const countPassingMetrics = (caseScore: CaseScore): number => {
  return caseScore.metrics.filter(doesMetricPass).length;
};
