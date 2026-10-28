import { SYNC_ACK_DETAIL_MAX_CHARS } from "@repo/api/src/types/agent-session";
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
 * behaviour. (Re-confirmed for ISS-8005: the desktop's only equality test
 * against this value is `schema_version_invalid`, in
 * `agent-session-sync-validation-failure.ts`; every other value is echoed into
 * a log line and nothing else.)
 *
 * ISS-8005: a per-session rejection additionally carries the FIELD PATH, as
 * `session_invalid:sessions[0].events[12].createdAt`. A rejected session is a
 * total loss (`packages/api/src/types/agent-session.ts`), and before this the
 * bare `session_invalid` named no field while nothing retained the wire payload
 * — so the field that caused a permanent loss could not be recovered by anyone
 * afterwards. Naming it makes that loss diagnosable; it does not prevent it.
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
    if (rest.length === 0) {
      return "sessions_invalid";
    }
    return `${SESSION_INVALID_REASON}:${renderIssuePath(issue.path)}`;
  }
  return "payload_invalid";
}

/**
 * The leading token of every per-session rejection, unchanged from before
 * ISS-8005 so an operator (and any log grep) still recognises the class. What
 * follows the `:` is the field path — see {@link renderIssuePath}.
 */
const SESSION_INVALID_REASON = "session_invalid";

/**
 * Keys under the session wire contract whose CHILD keys come from the payload
 * rather than the schema (`z.record`): a session's and an agent's `metadata`,
 * an activity bucket's `byModel`, and `phaseIterations`. A segment beneath one
 * of these is customer content — a metadata key, a model name, a phase label —
 * so the path stops there. Every other segment is a literal field name declared
 * by the schema, which is exactly what this diagnostic exists to name.
 */
const PAYLOAD_KEYED_FIELDS = new Set([
  "metadata",
  "byModel",
  "phaseIterations",
]);

/**
 * A field name the schema itself declares. Anything else reaching a path
 * position is treated as payload-supplied and masked, so a `z.record` added to
 * the contract without updating {@link PAYLOAD_KEYED_FIELDS} still cannot emit
 * a raw key unless that key also happens to look like a declared identifier.
 */
const SCHEMA_FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;

/** Stands in for a suppressed segment and for everything below it. */
const MASKED_SEGMENT = "*";

/**
 * Marks a path whose tail was dropped by {@link MAX_ISSUE_PATH_CHARS}.
 * Deliberately NOT {@link MASKED_SEGMENT}: the two mean different things (one
 * withheld customer content, the other ran out of budget), and without a marker
 * a truncated prefix reads as a complete path and names the wrong field — the
 * exact failure this diagnostic exists to end.
 */
const TRUNCATED_SUFFIX = "...";

/**
 * Keeps `session_invalid:<path>` inside {@link SYNC_ACK_DETAIL_MAX_CHARS}, the
 * budget the desktop slices this diagnostic to before logging it, so the field
 * the operator needs is never the part that gets sliced off. DERIVED rather
 * than spelled: the desktop's slice emits no truncation marker, so a hand-typed
 * number that fell behind the shared budget would silently reintroduce exactly
 * the unmarked, wrong-field prefix {@link TRUNCATED_SUFFIX} exists to prevent.
 */
const MAX_ISSUE_PATH_CHARS =
  SYNC_ACK_DETAIL_MAX_CHARS -
  (SESSION_INVALID_REASON.length + ":".length) -
  TRUNCATED_SUFFIX.length;

/**
 * A Zod issue path rendered as `sessions[0].events[12].createdAt` — field names
 * and array indices ONLY.
 *
 * PROTECTS THE ACK `detail` AND THE DESKTOP LOG IT IS ECHOED INTO, and nothing
 * else: it emits no VALUE from the payload, and it emits {@link MASKED_SEGMENT}
 * — a withheld-content marker — only when a payload-supplied key was actually
 * reached, never speculatively. The raw request body is untouched by this and is
 * not a sink this bounds. Rendering stops at the first payload-supplied segment
 * and at {@link MAX_ISSUE_PATH_CHARS}.
 */
function renderIssuePath(path: PropertyKey[]): string {
  let rendered = "";
  // Sticky: a numeric index inside a payload-keyed blob (`metadata` holding an
  // array) must not clear it, or the next object key below that array — still
  // customer content — would be emitted verbatim.
  let insidePayloadKeyedField = false;
  for (const segment of path) {
    if (typeof segment === "number") {
      const withIndex = `${rendered}[${segment}]`;
      if (withIndex.length > MAX_ISSUE_PATH_CHARS) {
        return `${rendered}${TRUNCATED_SUFFIX}`;
      }
      rendered = withIndex;
      continue;
    }
    const name = String(segment);
    if (insidePayloadKeyedField || !SCHEMA_FIELD_NAME_PATTERN.test(name)) {
      return `${rendered}.${MASKED_SEGMENT}`;
    }
    const next = rendered === "" ? name : `${rendered}.${name}`;
    if (next.length > MAX_ISSUE_PATH_CHARS) {
      return `${rendered}${TRUNCATED_SUFFIX}`;
    }
    rendered = next;
    insidePayloadKeyedField = PAYLOAD_KEYED_FIELDS.has(name);
  }
  return rendered;
}
