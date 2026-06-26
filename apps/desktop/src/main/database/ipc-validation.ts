// Runtime validation for renderer-supplied identifiers that reach the
// `desktop:db:*` IPC handlers. IPC is a runtime trust boundary: the TypeScript
// annotations on the handler arguments are erased at runtime, so a malformed
// `id` / `sessionId` / `agentId` (an object, number, null, or oversized string)
// from a compromised or buggy renderer could otherwise reach database bindings
// and throw inside the query or alter its behavior. The DB IPC handlers
// must coerce every identifier through these guards before it touches the store
// layer. (CLAUDE.md: runtime-validate gateway, IPC, and persisted payloads.)

/**
 * Upper bound on identifier length. Session/agent ids are short UUID-ish
 * strings; anything dramatically longer is malformed input, not a real id.
 */
export const MAX_DB_ID_LENGTH = 512;

/**
 * Validate a renderer-supplied database identifier.
 *
 * Returns the value unchanged when it is a usable id (a non-empty string within
 * the length bound), or `null` when it is not. Callers treat `null` as "no such
 * record" — they return the same empty/undefined result the handlers already
 * return when the monitor is disabled, so a bad argument can never reach a
 * database binding.
 */
export function coerceDbId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length === 0 || value.length > MAX_DB_ID_LENGTH) {
    return null;
  }
  return value;
}
