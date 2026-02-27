import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";

/**
 * Acceptance rate calculation result.
 */
export type AcceptanceRate = {
  acceptedCount: number;
  totalCount: number;
  rate: number;
};

/**
 * Calculate acceptance rate from judge feedback items.
 * An item is considered "accepted" if its score is >= its threshold.
 */
export function calculateAcceptanceRate(
  items: JudgeFeedbackItem[] | undefined
): AcceptanceRate {
  if (!items || items.length === 0) {
    return { acceptedCount: 0, totalCount: 0, rate: 0 };
  }

  const acceptedCount = items.filter(
    (m) => m.threshold !== null && m.score >= m.threshold
  ).length;
  const totalCount = items.length;
  const rate = (acceptedCount / totalCount) * 100;

  return { acceptedCount, totalCount, rate };
}

/**
 * Sort judge feedback items by score in ascending order (worst/lowest first).
 * This brings attention to items that need improvement.
 */
export function sortMetricsByScore(
  items: JudgeFeedbackItem[]
): JudgeFeedbackItem[] {
  return [...items].sort((a, b) => a.score - b.score);
}
