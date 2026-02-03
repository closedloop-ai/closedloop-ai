import type { MetricStatistics } from "@/types/evaluation";

/**
 * Factory for creating mock MetricStatistics objects.
 * Use this across all test files that need evaluation metric test data.
 */
export const createMockMetric = (
  name: string,
  mean: number,
  overrides?: Partial<MetricStatistics>
): MetricStatistics => ({
  metric_name: name,
  mean,
  std_dev: 0.1,
  min: mean - 0.2,
  max: mean + 0.2,
  pass_rate: mean >= 0.7 ? 1.0 : 0.0,
  threshold: 0.7,
  sample_count: 10,
  scores: [mean],
  ...overrides,
});
