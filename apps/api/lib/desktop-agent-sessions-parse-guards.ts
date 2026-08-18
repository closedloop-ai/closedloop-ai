import { sanitizePostgresJson } from "./agent-sessions-text-sanitizer";

/**
 * Parse-time guards for the desktop → cloud agent-session sync payload, split
 * out of `desktop-agent-sessions-schema.ts` so that module states the payload
 * SHAPE while this one owns the two checks that run either side of it: what the
 * RAW payload may contain before Zod sees it, and how a Zod failure becomes the
 * ack `reason` the desktop reads.
 */

/**
 * The only synced fields whose object *keys* are persisted verbatim into a jsonb
 * column and can therefore lose data if two keys collapse to one after
 * sanitization: a session's `metadata` and each agent's `metadata`. (FEA-2718
 * dropped the event `data`/`summary` columns — the schema now strips event
 * `data` before any DB write, so a collision inside it can no longer lose
 * persisted data and must not reject the batch.) Every other synced field is a
 * typed scalar/array whose keys are fixed ASCII identifiers (they never contain
 * a NUL or lone surrogate, so they cannot collide), and any unknown key at those
 * structural levels is stripped by the schema before a DB write. Scoping the
 * sanitized-key-collision check to these blobs is what keeps a collision in a
 * desktop-local / forward-compat field (which the schema drops) from wrongly
 * rejecting an otherwise-valid payload.
 */
const REJECT_COLLISIONS = { rejectKeyCollisions: true } as const;

// Narrow an unknown to a plain record, or null if it isn't an object.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

// A session's own `metadata` blob plus each of its agents' `metadata` blobs —
// the persisted jsonb whose keys survive verbatim on the sync batch. Non-object
// blobs are a harmless no-op.
function assertSessionMetadataBlobs(
  sessionRecord: Record<string, unknown>
): void {
  sanitizePostgresJson(sessionRecord.metadata, REJECT_COLLISIONS);
  const rawAgents = Array.isArray(sessionRecord.agents)
    ? sessionRecord.agents
    : [];
  for (const rawAgent of rawAgents) {
    const agentRecord = asRecord(rawAgent);
    if (agentRecord) {
      sanitizePostgresJson(agentRecord.metadata, REJECT_COLLISIONS);
    }
  }
}

export function assertPersistedJsonBlobsHaveNoKeyCollision(
  rawPayload: unknown
): void {
  // Re-run the sanitizer on the RAW blobs (pre-sanitization keys still intact)
  // with collision rejection ON. The main sanitize pass leaves collisions to a
  // silent last-write-wins so that stripped fields can't trigger a rejection;
  // this narrow pass is where a real, data-losing collision in a persisted blob
  // is surfaced. `sanitizePostgresJson` ignores non-object blobs, so passing an
  // absent/typed value is a harmless no-op.
  const record = asRecord(rawPayload);
  if (!record) {
    return;
  }
  // Batch payload: sessions[].metadata and sessions[].agents[].metadata. Event
  // `data` is deliberately NOT checked — FEA-2718 dropped it from the persisted
  // event shape (the schema strips it before any DB write), so a key collision
  // there loses no persisted data and must not reject an otherwise-valid batch.
  const rawSessions = Array.isArray(record.sessions) ? record.sessions : [];
  for (const rawSession of rawSessions) {
    const sessionRecord = asRecord(rawSession);
    if (sessionRecord) {
      assertSessionMetadataBlobs(sessionRecord);
    }
  }
}

/**
 * The first schema issue, mapped to a stable, value-free summary. Unrecognised
 * paths fall back to the generic `payload_invalid` rather than leaking a Zod
 * message. ISS-5090 returns this to the desktop as `details.reason` on the coded
 * 400, but strictly as a DIAGNOSTIC an operator reads — no client switches on
 * it, so a newer value can never change a client's classification or retry
 * behaviour.
 */
export function summarizeParseIssues(
  issues: Array<{ path: PropertyKey[]; message: string }>
): string {
  const issue = issues[0];
  if (!issue) {
    return "payload_invalid";
  }
  const [root, ...rest] = issue.path;
  if (root === "schemaVersion") {
    return "schema_version_invalid";
  }
  if (root === "batchId") {
    return "batch_id_invalid";
  }
  if (root === "syncMode") {
    return "sync_mode_invalid";
  }
  if (root === "sessionCount") {
    return issue.message === "session_count_mismatch"
      ? "session_count_mismatch"
      : "session_count_invalid";
  }
  if (root === "sessions") {
    if (issue.message === "session_trace_source_payload_too_large") {
      return issue.message;
    }
    return rest.length > 0 ? "session_invalid" : "sessions_invalid";
  }
  return "payload_invalid";
}
