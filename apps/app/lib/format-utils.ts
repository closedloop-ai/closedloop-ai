/**
 * Shared formatting utilities for loops UI.
 */

/**
 * Format a token count for display (e.g., 1500 → "1.5k", 2000000 → "2.0M").
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

/**
 * Format duration between two dates as "Xm Ys" or "Ys".
 * If startedAt is null, returns "-".
 * If completedAt is null, measures against Date.now().
 */
export function formatDuration(
  startedAt: Date | null,
  completedAt: Date | null
): string {
  if (!startedAt) {
    return "-";
  }
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Build URLSearchParams from a filters object, skipping null/undefined values.
 */
export function buildSearchParams(
  filters: Record<string, unknown>
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  return params;
}
