/**
 * Format a 0–1 score as a rounded percentage string (e.g. 0.78 → "78%").
 */
export function formatScorePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}
