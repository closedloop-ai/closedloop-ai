/**
 * @file rate-limit-narrow.ts
 * @description Shared narrower for the "one rate-limit window" shape consumed by
 * both {@link file://./utilization.ts mapUtilizationResponse} and
 * {@link file://./mappers.ts mapStatuslineRateLimits} (PRD-539, FEA-3493).
 *
 * The two upstreams disagree only on which fields carry the utilization number
 * and reset time (e.g. `utilization`+`resets_at` ISO vs `used_percentage`+epoch
 * `resets_at`), so the defensive object-narrowing and null-when-absent contract
 * are factored here and parameterized by field-specific extractors. Never throws.
 */
import type { RateLimitSnapshot } from "../../shared/session-limits-channel.js";

/**
 * Narrow an `unknown` window payload to a {@link RateLimitSnapshot}, delegating
 * the field-specific parsing to the two extractors. Returns null when the input
 * is not an object or the extractor yields no utilization number.
 */
export function narrowRateLimitPayload(
  value: unknown,
  extractUtilization: (v: Record<string, unknown>) => number | null,
  extractResetsAt: (v: Record<string, unknown>) => string | null
): RateLimitSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v = value as Record<string, unknown>;
  const utilization = extractUtilization(v);
  if (utilization === null) {
    return null;
  }
  return {
    utilization,
    resetsAt: extractResetsAt(v),
  };
}

/**
 * Convert an epoch-SECONDS reset timestamp to ISO-8601, or null when the value
 * is not a usable positive finite number. Shared because both upstreams can
 * express `resets_at` that way: the statusline always does, and the `/usage`
 * endpoint does on some windows (the shipped CLI branches on
 * `typeof resets_at === "number"` before rendering). Never throws.
 */
export function epochSecondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}
