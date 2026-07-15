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

/**
 * Narrows an unknown value to a plain object record, or `null` when it is not.
 *
 * The coercing counterpart to {@link isRecord}: returns the value typed as a
 * record for non-null, non-array objects and `null` otherwise, so callers can
 * write `const rec = asRecord(x); if (rec) …` instead of re-implementing the
 * same guard. Use `isRecord` when a boolean predicate is enough. This is a
 * deliberately different contract from the `{}`-fallback `asRecord` variants in
 * the tolerant harness parsers (claude/cursor), which never return `null`.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
