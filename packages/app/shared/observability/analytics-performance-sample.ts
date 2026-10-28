/**
 * Bounded, cardinality-safe performance properties shared by surface analytics
 * emitters (the Project Artifact Board and the Sessions v2 list), so a count or
 * a duration is reported in one shape wherever it is measured.
 */

const MAX_REPORTED_DURATION_MS = 60_000;

/** True for a count an analytics bucket can describe. */
export function isAnalyticsCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** One duration sample capped at a minute, or `null` for an invalid measurement. */
export function analyticsDurationProperties(
  durationMs: number
): { duration_capped: boolean; duration_ms: number } | null {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  const roundedDuration = Math.round(durationMs);
  return {
    duration_capped: roundedDuration > MAX_REPORTED_DURATION_MS,
    duration_ms: Math.min(roundedDuration, MAX_REPORTED_DURATION_MS),
  };
}

/** A closed bucket for a count, so no raw size reaches analytics. */
export function analyticsCountBucket(value: number): string {
  if (value === 0) {
    return "0";
  }
  if (value <= 5) {
    return "1-5";
  }
  if (value <= 20) {
    return "6-20";
  }
  if (value <= 100) {
    return "21-100";
  }
  return "101+";
}
