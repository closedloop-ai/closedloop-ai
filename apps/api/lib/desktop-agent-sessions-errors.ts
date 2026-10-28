import type { DesktopAgentSessionsAckReason } from "@repo/api/src/types/agent-session";
import type { StatusCode } from "@repo/api/src/types/result";

/**
 * Errors the desktop session-sync ingest raises for a rejection that is
 * DETERMINISTIC and CLIENT-SHAPED: re-sending the identical payload produces the
 * identical rejection, so the server cannot fix it by trying again and the
 * desktop must change what it sends. The handler taxonomizes every one of these
 * as `validation_failed` (HTTP 400), never `ingestion_failed` (500) — a 500 tells
 * the desktop to defer the whole batch on a transient-server budget, which for a
 * deterministic payload defect means re-sending the same doomed bytes until a
 * bound expires.
 */
export abstract class DesktopAgentSessionsClientRejectionError extends Error {}

/**
 * ISS-8271 (cr-15119 bha_p0_f0): a batch that did NOT opt into the row-level
 * ack (`wantsAcceptedSessionIds`) carries a session whose revision the apply
 * would HOLD (sentinel / too-new). The hold's only re-send signal is omission
 * from `persistedSessionIds`; without the echo the legacy whole-batch contract
 * acks every sent id on success, so accepting would let a version-skewed
 * desktop durably clear the outbox row for a session the server refused to
 * write — silent loss. Rejecting restores the exact pre-ISS-8271 contract for
 * those builds (the sentinel stamps predate the echo: ISS-4572 vs #4862):
 * deterministic `validation_failed`, row retained desktop-side.
 */
export class HeldRevisionRequiresRowLevelAckError extends DesktopAgentSessionsClientRejectionError {
  constructor() {
    super("held_revision_requires_row_level_ack");
    this.name = "HeldRevisionRequiresRowLevelAckError";
  }
}

/**
 * Deterministic validation failure raised when one stable token transport id
 * names different immutable event content.
 */
export class TokenEventTransportIdentityCollisionError extends DesktopAgentSessionsClientRejectionError {
  constructor() {
    super("token_event_transport_identity_collision");
    this.name = "TokenEventTransportIdentityCollisionError";
  }
}

/**
 * ISS-7767: the sync route's un-thrown ingest rejection, given a shape the
 * request span can classify.
 *
 * `errorResponse` reduces its error argument to `error.type` through
 * `resolveSpanErrorType`, which can only name an OBJECT. That call site used to
 * hand it the bare `reason` string, so the 500 recorded `app.error.source` with
 * no `error.type` beside it — and that branch is the route's *unclassified*
 * fallthrough (ISS-7730), which made the platform's largest 5xx source its least
 * diagnosable one. The reason rides on `code` because that is the field the
 * resolver appends to the class name; a reason it cannot code-shape (a numeric
 * `StatusCode`) simply degrades to the class name alone rather than dropping the
 * attribute.
 */
export class DesktopAgentSessionsSyncError extends Error {
  readonly code: string;

  constructor(reason: StatusCode | DesktopAgentSessionsAckReason) {
    super(String(reason));
    this.name = "DesktopAgentSessionsSyncError";
    this.code = String(reason);
  }
}

/** Which NOT NULL session timestamp column the refused value was headed for. */
export const SessionTimestampField = {
  StartedAt: "startedAt",
  UpdatedAt: "updatedAt",
} as const;
export type SessionTimestampField =
  (typeof SessionTimestampField)[keyof typeof SessionTimestampField];

/**
 * ISS-8735: a session whose `startedAt`/`updatedAt` is below the earliest
 * instant a Postgres `timestamp` can hold, refused at the slice before it
 * reaches the NOT NULL INSERT that throws on it today.
 *
 * Deliberately a plain `Error`, NOT a
 * {@link DesktopAgentSessionsClientRejectionError}: that base class makes the
 * handler taxonomize the escaped error as `validation_failed` (400), and the
 * error only escapes on a legacy batch (no `wantsAcceptedSessionIds`) or one
 * whose every attempted slice failed — precisely the requests that answer
 * `ingestion_failed` (500) today, from the Postgres throw this guard replaces.
 * The ticket rules retry semantics unchanged; a permanent per-session refusal
 * is ISS-8131's cloud-side hold, not this class.
 */
export class SessionTimestampOutOfRangeError extends Error {
  readonly field: SessionTimestampField;
  readonly value: string;

  constructor(field: SessionTimestampField, value: string) {
    super(`session_timestamp_out_of_range:${field}`);
    this.name = "SessionTimestampOutOfRangeError";
    this.field = field;
    this.value = truncateRefusedTimestamp(value);
  }
}

/**
 * How much of the refused wire string the log record carries.
 *
 * `isoDateSchema` bounds this field by parseability, NOT by length, so the value
 * is caller-controlled input on its way to a log line and needs a bound of its
 * own. 64 characters is comfortably past the longest form that can reach here —
 * an extended-year ISO-8601 instant like `-271821-04-20T00:00:00.000Z` is 28.
 */
export const REFUSED_TIMESTAMP_LOG_MAX_CHARS = 64;

function truncateRefusedTimestamp(value: string): string {
  return value.length <= REFUSED_TIMESTAMP_LOG_MAX_CHARS
    ? value
    : value.slice(0, REFUSED_TIMESTAMP_LOG_MAX_CHARS);
}
