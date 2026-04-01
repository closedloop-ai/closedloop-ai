import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";

/**
 * Returns a formatted percentage string (e.g. "85%") averaged across all items,
 * or null when items is empty/nullish so callers can distinguish no evaluation from 0%.
 */
export function deriveScoreDisplay(
  items: JudgeFeedbackItem[] | null | undefined
): string | null {
  if (!items || items.length === 0) {
    return null;
  }

  const avg = items.reduce((acc, item) => acc + item.score, 0) / items.length;

  return `${Math.round(avg * 100)}%`;
}
