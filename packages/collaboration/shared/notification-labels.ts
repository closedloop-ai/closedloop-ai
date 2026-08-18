// Canonical readable fallback for a session that has no human-readable title.
// This module is the single owner of the string; the Active-runs projection
// (`packages/app/agents/lib/active-runs.ts`) imports it rather than repeating
// the literal, so the untitled-session label cannot silently drift.
export const UNTITLED_SESSION_LABEL = "Untitled session";

// Matches a bare RFC-4122 UUID (the raw session id). Some notification
// producers set `sessionTitle` to the session id itself (FEA-3969); a raw UUID
// is not a human-readable title, so we treat it like a missing title and fall
// back to a readable label instead of printing the database id.
const BARE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Matches the legacy synthetic name the sync producer assigns to an unnamed
// session — `Session <externalSessionId>` (see apps/api agent-sessions
// service). Persisted awaiting-input notifications carry that whole value as
// `sessionTitle`, so `Session <uuid>` must fall back to the readable label too;
// otherwise the exact case FEA-3969 repairs still renders the raw id. A real
// title that merely starts with "Session " and has more text after the id
// (e.g. `Session <uuid> follow-up`) is preserved.
const LEGACY_UNNAMED_SESSION_RE =
  /^Session\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the human-readable label to show for an awaiting-input notification.
 *
 * The visible label must describe what needs input, never a raw database id
 * (FEA-3969). Prefer a real title from the notification payload; when the title
 * is absent, blank, the raw session UUID, or the legacy synthetic
 * `Session <uuid>` name the producer assigns to unnamed sessions, fall back to
 * a readable label. The UUID stays a link target only (the caller uses
 * `sessionUrl` as the `href`), never the visible text.
 */
export function resolveSessionNotificationTitle(sessionTitle: unknown): string {
  if (typeof sessionTitle !== "string") {
    return UNTITLED_SESSION_LABEL;
  }
  const trimmed = sessionTitle.trim();
  if (
    trimmed.length === 0 ||
    BARE_UUID_RE.test(trimmed) ||
    LEGACY_UNNAMED_SESSION_RE.test(trimmed)
  ) {
    return UNTITLED_SESSION_LABEL;
  }
  return trimmed;
}
