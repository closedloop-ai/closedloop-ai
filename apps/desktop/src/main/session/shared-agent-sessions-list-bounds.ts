/**
 * Paging bounds for the shared agent-sessions list query.
 *
 * A limit or offset arriving from the renderer is untrusted: it can be a
 * non-number, `NaN`, `Infinity`, a fraction, or negative. Both clamps floor the
 * value first and then bound it, so a limit can never be 0 or negative (which
 * would silently return an empty page) and an offset can never be negative
 * (which SQLite would reject). A non-finite or non-numeric input falls back to
 * the default rather than propagating a bad value into the query.
 *
 * Extracted verbatim from `shared-agent-sessions-api.ts` (ISS-4771 shrink-only
 * discipline: an over-ceiling grandfathered file must end up smaller than it
 * started).
 */

export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;

export function clampLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_LIST_LIMIT);
}

export function clampOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(Math.floor(value), 0);
}
