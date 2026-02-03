import type {
  CaseScore,
  EvalStatus,
  MetricStatistics,
} from "@/types/evaluation";

/**
 * Factory for creating mock MetricStatistics objects.
 * Use this across all test files that need metric test data.
 *
 * Automatically calculates pass_rate and threshold based on score:
 * - score 1 (Poor): pass_rate 0.0, threshold 2.5
 * - score 2 (Needs Improvement): pass_rate 0.5, threshold 2.0
 * - score 3 (Great): pass_rate 1.0, threshold 2.5
 */
export const createMockMetricStatistics = (
  overrides?: Partial<MetricStatistics> & { score?: EvalStatus }
): MetricStatistics => {
  const { score = 3, ...rest } = overrides ?? {};

  const threshold = score === 2 ? 2.0 : 2.5;
  let passRate = 0.0;
  if (score === 2) {
    passRate = 0.5;
  } else if (score === 3) {
    passRate = 1.0;
  }

  return {
    metric_name: "Test Metric",
    mean: score,
    std_dev: 0.0,
    min: score,
    max: score,
    pass_rate: passRate,
    threshold,
    sample_count: 1,
    scores: [score],
    justification: ["Default test justification"],
    ...rest,
  };
};

/**
 * Simplified factory for creating mock MetricStatistics with positional arguments.
 * Use for tests that need quick metric creation with name and mean.
 *
 * @param name - The metric name
 * @param mean - The mean score value
 * @param overrides - Optional overrides for other fields
 */
export const createMockMetric = (
  name: string,
  mean: number,
  overrides?: Partial<MetricStatistics>
): MetricStatistics => {
  return createMockMetricStatistics({
    metric_name: name,
    mean,
    min: mean,
    max: mean,
    scores: [mean],
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
  weighted_score: 2.5,
  metrics: [createMockMetricStatistics()],
  type: "case_score",
  case_id: "case-123",
  eval_set_id: "eval-set-123",
  final_status: 3,
  ...overrides,
});
