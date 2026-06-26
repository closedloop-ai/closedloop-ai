/**
 * Narrows an unknown value to a plain object record.
 *
 * Returns true only for non-null, non-array objects, making it safe to index
 * the value with string keys (e.g. after `JSON.parse`). Shared across the
 * desktop main and server process domains so callers stop hand-rolling the
 * same guard.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
