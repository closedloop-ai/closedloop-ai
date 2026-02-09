import type { MetricStatistics } from "@repo/api/src/types/evaluation";

/**
 * Acceptance rate calculation result.
 */
export type AcceptanceRate = {
  acceptedCount: number;
  totalCount: number;
  rate: number;
};

/**
 * Calculate acceptance rate from evaluation metrics.
 * A metric is considered "accepted" if its mean score is >= its threshold.
 * Only metrics with non-null thresholds are included in the calculation.
 */
export function calculateAcceptanceRate(
  metrics: MetricStatistics[] | undefined
): AcceptanceRate {
  if (!metrics || metrics.length === 0) {
    return { acceptedCount: 0, totalCount: 0, rate: 0 };
  }

  const acceptedCount = metrics.filter(
    (m) => m.threshold !== null && m.score >= m.threshold
  ).length;
  const totalCount = metrics.length;
  const rate = (acceptedCount / totalCount) * 100;

  return { acceptedCount, totalCount, rate };
}

/**
 * Sort metrics by score in ascending order (worst/lowest first).
 * This brings attention to metrics that need improvement.
 */
export function sortMetricsByScore(
  metrics: MetricStatistics[]
): MetricStatistics[] {
  return [...metrics].sort((a, b) => a.score - b.score);
}
