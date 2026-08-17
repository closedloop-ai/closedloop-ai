/**
 * @file desktop-agent-components-parse.ts
 * @description ISS-4662 — the sanitize-then-validate entry point for
 * `POST /desktop/components/sync`.
 *
 * Split from `desktop-agent-sessions-schema.ts` (which is at the
 * `noExcessiveLinesPerFile` ceiling) because it is its own responsibility: that
 * file DEFINES the wire shapes, this one owns what a route must do to a raw body
 * before trusting it. The session lane's equivalent (`parseDesktopAgentSessionsPayload`)
 * still lives beside its schemas; when that file is next split, this is where its
 * parse half belongs too.
 */
import {
  PostgresJsonDepthExceededError,
  PostgresJsonKeyCollisionError,
  sanitizePostgresJson,
} from "./agent-sessions-text-sanitizer";
import { summarizeParseIssues } from "./desktop-agent-sessions-parse-guards";
import {
  type DesktopAgentComponentsPayload,
  desktopAgentComponentsPayloadSchema,
} from "./desktop-agent-sessions-schema";

/** Outcome of {@link parseDesktopAgentComponentsPayload}. */
export type DesktopAgentComponentsParseResult =
  | { ok: true; payload: DesktopAgentComponentsPayload }
  | { ok: false; reason: string };

/**
 * Parse a `POST /desktop/components/sync` body, sanitizing it for Postgres FIRST.
 *
 * The component lane persists `content` — and now every variant `content` — into
 * Postgres `text`, which rejects NUL and lone surrogates. This route validated
 * the RAW body, so one NUL-bearing definition passed the schema and then threw
 * from the write as an opaque 500, leaving the desktop's cursor to retry the same
 * poison batch forever (wongk, #4295). The session lane has sanitized before
 * validation since FEA-2258 for exactly this reason; this reuses that sanitizer
 * rather than adding a second one.
 *
 * Sanitizing BEFORE the schema (not after) matters for the same reason it does
 * there: stripping a NUL can shorten or empty a string, so a sanitize-after-validate
 * would let a required `min(1)` identity field pass as `"\0"` and then collapse to
 * `""` — a shape the schema would have rejected. Validating the sanitized payload
 * guarantees the values that reach the database still satisfy the schema.
 *
 * Unlike the session lane this does NOT run the key-collision assertion: the
 * components payload persists no caller-keyed JSON blob whose keys survive
 * verbatim, so a sanitized-key collision has nothing here to silently overwrite.
 */
export function parseDesktopAgentComponentsPayload(
  payload: unknown
): DesktopAgentComponentsParseResult {
  let sanitizedPayload: unknown;
  try {
    sanitizedPayload = sanitizePostgresJson(payload);
  } catch (error) {
    if (error instanceof PostgresJsonDepthExceededError) {
      return { ok: false, reason: "payload_nested_too_deeply" };
    }
    if (error instanceof PostgresJsonKeyCollisionError) {
      return { ok: false, reason: "payload_sanitized_key_collision" };
    }
    throw error;
  }
  const parsed =
    desktopAgentComponentsPayloadSchema.safeParse(sanitizedPayload);
  if (!parsed.success) {
    return { ok: false, reason: summarizeParseIssues(parsed.error.issues) };
  }
  return { ok: true, payload: parsed.data };
}
