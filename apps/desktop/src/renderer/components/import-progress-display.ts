export type ImportProgressDisplay = {
  processed: number;
  total: number;
  pct: number;
};

/**
 * Normalize imported/total session counts for renderer-only progress displays.
 *
 * The runtime should emit integer counts, but the UI still clamps defensively so
 * transient malformed payloads never show negative sessions, processed > total,
 * or a `NaN` progress value.
 */
export function describeImportProgress(
  processed: number,
  total: number
): ImportProgressDisplay {
  const displayTotal = normalizeCount(total);
  const displayProcessed =
    displayTotal > 0 ? Math.min(normalizeCount(processed), displayTotal) : 0;
  const pct = displayTotal > 0 ? (displayProcessed / displayTotal) * 100 : 0;

  return {
    processed: displayProcessed,
    total: displayTotal,
    pct,
  };
}

/** Clamp a percentage into the display range used by progressbar ARIA values. */
export function clampPercent(pct: number): number {
  if (!Number.isFinite(pct)) {
    return 0;
  }

  return Math.max(0, Math.min(100, pct));
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}
