const LABEL_SEPARATOR_PATTERN = /[-_:]/;

/**
 * Turns a machine token (e.g. `in_progress`, `pull-request`, `status:open`) into
 * a human-readable, title-cased label ("In Progress", "Pull Request",
 * "Status Open"). Splits on `-`, `_`, and `:`.
 *
 * Note: this deliberately does NOT split on whitespace. The `titleize()` helper
 * in `session-trace/derivation.ts` has a different contract (splits on
 * whitespace, not `:`), so the two are intentionally kept separate.
 */
export function labelize(value: string): string {
  return value
    .split(LABEL_SEPARATOR_PATTERN)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
