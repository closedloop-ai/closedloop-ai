/**
 * @file agent-session-sync-validation-failure.ts
 * @description ISS-5090: how the session lane classifies a `validation_failed`
 * ack, and which retry budget that classification is allowed to spend.
 *
 * `sync/AGENTS.md` invariant 4 says only a ROW-ATTRIBUTABLE failure may exhaust
 * a session's budget. A `validation_failed` was treated as row-attributable
 * unconditionally, but the rejection is answered against the ENVELOPE the lane
 * happened to build, and an oversized session's envelope is not a stable
 * property of the persisted row: the partition depends on the negotiated byte
 * cap, the encoding, the activity-chunking capability, and how large the source
 * streams were at prepare time. Production proved the gap — the same ended
 * session was rejected six times as a three-part sequence, dead-lettered
 * TERMINALLY after three consecutive rejections, and then accepted in full
 * hours later as a FOUR-part sequence. Nothing about the row changed.
 *
 * So a rejection of one part of a multi-part sequence is classified
 * `ChunkEnvelope`: it gets its own bounded budget, and when that budget is spent
 * the dead-letter is RECOVERABLE — the FEA-3363/FEA-3795 progressive retry
 * ladder re-drives it live instead of parking it until a cold restart. Only a
 * rejection of a session shipped WHOLE (`Row`) is reproducible from the same
 * persisted content, so only it spends the deterministic budget and dead-letters
 * non-recoverably. A multi-id envelope keeps its FEA-4375 `Bisect` behaviour —
 * the ack names no session, so nothing may be charged until the batch is
 * re-sent one id at a time.
 *
 * Ahead of all three, the server's `details.reason` is read as a discriminator:
 * a `schema_version_invalid` is a fact about the desktop build's envelope and a
 * `compute_target_id_invalid` is a fact about the lane's own connection state,
 * neither of them about any row, so both are classified `LaneWide` and deferred
 * with every budget intact. Inferring either from the batch shape would charge
 * it to whichever sessions happened to be in flight and eventually dead-letter
 * them. Every other reason value — and the omission an older API sends — leaves
 * the shape-derived classification untouched.
 *
 * Pure over injected collaborators, like `agent-session-sync-ack-fold.ts`: this
 * module owns no state, so the service keeps its counters and this stays
 * trivially testable (and the grandfathered service file keeps shrinking).
 */

import {
  type AgentSessionSyncMode,
  SYNC_ACK_DETAIL_MAX_CHARS,
} from "@repo/api/src/types/agent-session";
import { DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID } from "@repo/api/src/types/desktop-sync-ack-detail";
import type { BoundedFailureFoldConfig } from "./agent-session-sync-ack-fold.js";
import {
  MAX_CHUNK_ENVELOPE_DEAD_LETTERS,
  MAX_CONSECUTIVE_VALIDATION_FAILED,
  VALIDATION_FAILED_BACKOFF_MS,
} from "./agent-session-sync-backoff-policy.js";
import type { AgentSessionSyncBatch } from "./agent-session-sync-contract.js";
import { sanitizeUntrustedServerText } from "./agent-session-sync-service-helpers.js";

/**
 * The outbox `last_error` reasons this classifier records, kept together so an
 * operator reading the outbox can tell the three outcomes apart: a row the
 * server rejected as itself invalid, an envelope rejection still being
 * re-driven, and an envelope rejection that ran out of re-drives.
 */
export const VALIDATION_FAILED_REASON = "validation_failed" as const;
export const CHUNK_VALIDATION_FAILED_REASON =
  "chunk_validation_failed" as const;
export const CHUNK_VALIDATION_EXHAUSTED_REASON =
  "chunk_validation_exhausted" as const;

/**
 * Every `last_error` this classifier can write. Resume maps all of them onto the
 * SAME budget (see `isValidationFailureReason`), because they are one
 * consecutive-rejection count split only by how the rejection is reported.
 */
export function isValidationFailureReason(reason: string | null): boolean {
  return (
    reason === VALIDATION_FAILED_REASON ||
    reason === CHUNK_VALIDATION_FAILED_REASON ||
    reason === CHUNK_VALIDATION_EXHAUSTED_REASON
  );
}

export const ValidationFailureClass = {
  /**
   * The server rejected a property of the LANE, not anything about the sessions
   * inside the batch — the envelope's declared schema version, or the
   * `computeTargetId` this lane reads off the relay hello ack. Budget-neutral:
   * no row is at fault, so nothing is charged and nothing may dead-letter. See
   * {@link ValidationFailureDetail}.
   */
  LaneWide: "lane_wide",
  /**
   * The rejected envelope carried more than one session. The ack names none of
   * them, so no budget moves — the batch is flagged for singleton bisection.
   */
  Bisect: "bisect",
  /**
   * One session, shipped as one part of a MULTI-part chunk sequence. Not
   * reproducible from the persisted row alone (the partition varies per
   * attempt), so it may not spend the deterministic budget.
   */
  ChunkEnvelope: "chunk_envelope",
  /**
   * One session, shipped WHOLE. The server rejected exactly the content the row
   * holds, so a repeat is genuinely deterministic and may dead-letter terminally.
   */
  Row: "row",
} as const;

export type ValidationFailureClass =
  (typeof ValidationFailureClass)[keyof typeof ValidationFailureClass];

/**
 * True when this batch shipped one part of a MULTI-part chunk sequence. Read off
 * the wire payload itself (`chunk.total`, stamped by `stampChunkMetadata`)
 * rather than from lane state, so it is correct for both the chunk-0 send of a
 * fresh sequence and every later drain off the pinned tail. An unchunked session
 * carries no marker, and a session that chunked to exactly one part is stamped
 * `0 of 1` — both are whole sessions and both read as `false`.
 */
export function isMultiPartSyncEnvelope(batch: AgentSessionSyncBatch): boolean {
  return batch.sessions.some((session) => (session.chunk?.total ?? 1) > 1);
}

/**
 * FEA-4375: if the head of a picked batch is flagged for validation bisection,
 * send it ALONE so a `validation_failed` rejection pins to the single offender
 * instead of its healthy neighbors. Once that singleton acks or spends its
 * budget the flag clears and full-size batches resume; other batches pass
 * through unchanged so the common path keeps its throughput.
 */
export function capBatchForBisection(
  candidateIds: string[],
  bisectIds: ReadonlySet<string>
): string[] {
  if (candidateIds.length <= 1 || bisectIds.size === 0) {
    return candidateIds;
  }
  return bisectIds.has(candidateIds[0]) ? [candidateIds[0]] : candidateIds;
}

/**
 * Classify one `validation_failed` ack. See {@link ValidationFailureClass}.
 *
 * ISS-5090: the server's `details.reason` DISCRIMINATOR is read FIRST, before
 * the envelope/row split. A `schema_version_invalid` is a statement about the
 * batch envelope's declared schema version — a property of the desktop build,
 * identical for every batch this lane will send until one side is upgraded — so
 * inferring the class from the batch SHAPE instead would charge it to whichever
 * rows happened to be in flight and dead-letter them for a defect they do not
 * have. Any other value (including one this build has never heard of, and the
 * omission an older API sends) falls through to the existing shape-derived
 * classification, so an unknown reason can only ever degrade to today's generic
 * behaviour.
 *
 * ISS-8734 added `compute_target_id_invalid` on the same footing: the id is
 * lane state read off the relay hello ack rather than anything a row carries,
 * so it is identical for every batch until the connection is re-established.
 */
export function classifyValidationFailure(
  idCount: number,
  multiPartEnvelope: boolean,
  detail?: string
): ValidationFailureClass {
  if (laneWideValidationDetail(detail) !== undefined) {
    return ValidationFailureClass.LaneWide;
  }
  if (idCount > 1) {
    return ValidationFailureClass.Bisect;
  }
  return multiPartEnvelope
    ? ValidationFailureClass.ChunkEnvelope
    : ValidationFailureClass.Row;
}

/**
 * Cap on how much of an untrusted server-sent diagnostic is echoed into the
 * gateway log. The API's own vocabulary is a short closed set, but a peer is
 * version-skewed and a proxy-mangled body is reachable at this boundary, so the
 * value is truncated rather than trusted.
 *
 * ISS-8005: read from the shared contract rather than spelled here, because the
 * API now sizes the field path it sends against this same budget.
 */
const MAX_LOGGED_DETAIL_CHARS = SYNC_ACK_DETAIL_MAX_CHARS;

export type ValidationFailureInput = {
  syncMode: AgentSessionSyncMode;
  ids: string[];
  payloadBytes: number;
  /** Whether the rejected batch was one part of a multi-part chunk sequence. */
  multiPartEnvelope: boolean;
  /**
   * ISS-5090: the server's stable field/path summary for the rejection, when it
   * sent one. Optional and additive — an older API omits it — and only ever
   * logged, so an unknown value can never change classification.
   */
  detail?: string;
};

/** The service state/behaviour the classifier drives. Deliberately narrow. */
export type ValidationFailureDeps = {
  /**
   * The SINGLE per-session consecutive-rejection counter. Deliberately not split
   * per class: a session's envelope shape can flip between attempts (the
   * activity-chunking capability is renegotiated on reconnect, and gzip changes
   * the effective cap), so two counters would let a flipping session hold both
   * below their ceilings forever and never reach a terminal state at all —
   * exactly the unbounded retry `sync/AGENTS.md` invariant 5 forbids.
   */
  counter: Map<string, number>;
  /**
   * How many times this id has ALREADY been dead-lettered recoverably. Reads the
   * service's progressive-escalation count, which survives recovery and is
   * cleared only by a verified ack — so it is the one bound a recovered id
   * cannot reset by re-failing.
   */
  recoverableDeadLetterCountFor: (id: string) => number;
  markForBisection: (ids: string[], retryDeadlineMs: number) => void;
  clearBisectionFlag: (id: string) => void;
  applyBoundedFold: (config: BoundedFailureFoldConfig) => void;
  logInfo: (message: string) => void;
  formatBytes: (bytes: number) => string;
};

/**
 * Apply one `validation_failed` ack to the lane. All effects run through `deps`.
 */
export function applyValidationFailure(
  input: ValidationFailureInput,
  deps: ValidationFailureDeps
): void {
  const { syncMode, ids, payloadBytes, multiPartEnvelope, detail } = input;
  const failureClass = classifyValidationFailure(
    ids.length,
    multiPartEnvelope,
    detail
  );
  const bytes = deps.formatBytes(payloadBytes);
  const detailSuffix = formatServerDetailSuffix(detail);

  const laneWideDetail = laneWideValidationDetail(detail);
  if (laneWideDetail !== undefined) {
    // ISS-5090: a lane-wide rejection is resolved BEFORE the envelope/row split
    // — neither the id count nor the chunk marker says anything about a
    // rejection the whole lane will keep receiving. Deferring with budgets
    // intact is the only correct outcome: the fix is an upgrade (schema skew)
    // or a re-established connection (ISS-8734's computeTargetId), and burning
    // budget would dead-letter healthy rows for neither. The bisection flag is
    // deliberately NOT cleared — this ack proves nothing about which row is
    // poison, so any prior suspicion survives untouched.
    deferLaneWide(input, deps, detailSuffix, laneWideDetail);
    return;
  }

  if (failureClass === ValidationFailureClass.Bisect) {
    // FEA-4375: a batch-level validation_failed on a MULTI-id envelope cannot
    // name which nested session the server rejected (no per-item ids), so
    // charging every id's budget would eventually dead-letter healthy neighbors
    // for one poison row. Flag the whole batch for bisection and defer it; the
    // next pass (`capBatchForBisection`) re-sends each id ALONE so only the row
    // that fails singly burns its budget.
    deps.markForBisection(ids, Date.now() + VALIDATION_FAILED_BACKOFF_MS);
    deps.logInfo(
      `agent-session batch (${syncMode}, ~${bytes}) validation_failed on ${ids.length} sessions${detailSuffix}; ` +
        `bisecting to isolate the invalid row — re-sending each singly after ${Math.round(VALIDATION_FAILED_BACKOFF_MS / 1000)}s`
    );
    return;
  }

  // Reaching here with a SINGLE id is the bisection endpoint: the isolated
  // session burns its own budget, so the suspect flag is no longer needed.
  deps.clearBisectionFlag(ids[0]);

  // ISS-5090: the classification decides how the EXHAUSTED budget is reported,
  // not how large it is. A whole-session rejection is reproducible from the
  // persisted row, so it stays terminal (FEA-3366). A multi-part rejection is
  // attributable to the envelope, so it dead-letters RECOVERABLY and the
  // progressive ladder re-drives it live — the very retry that succeeded in
  // production hours after the terminal drop. That re-drive is itself bounded:
  // `recoverableDeadLetterCountFor` survives recovery (only a verified ack
  // clears it), so after `MAX_CHUNK_ENVELOPE_DEAD_LETTERS` cycles the class
  // becomes terminal too and the lane stops re-driving a genuinely-invalid row.
  const isChunkEnvelope = failureClass === ValidationFailureClass.ChunkEnvelope;
  const reDrivesLeft =
    deps.recoverableDeadLetterCountFor(ids[0]) <
    MAX_CHUNK_ENVELOPE_DEAD_LETTERS;
  const recoverable = isChunkEnvelope && reDrivesLeft;
  if (detailSuffix || isChunkEnvelope) {
    deps.logInfo(
      `agent-session ${ids[0]} (${syncMode}, ~${bytes}) rejected as validation_failed${detailSuffix}; ` +
        `attributed to the ${isChunkEnvelope ? "multi-part envelope" : "row itself"}` +
        (recoverable
          ? " — re-drivable"
          : " — terminal once the budget is spent")
    );
  }
  deps.applyBoundedFold({
    ids,
    syncMode,
    payloadBytes,
    counter: deps.counter,
    maxConsecutive: MAX_CONSECUTIVE_VALIDATION_FAILED,
    reason: chunkFailureReason(isChunkEnvelope, recoverable),
    recoverable,
    backoffMs: VALIDATION_FAILED_BACKOFF_MS,
    recordOutboxOnDefer: true,
  });
}

/** The durable `last_error` for a single-id rejection of the given class. */
function chunkFailureReason(
  isChunkEnvelope: boolean,
  recoverable: boolean
): string {
  if (!isChunkEnvelope) {
    return VALIDATION_FAILED_REASON;
  }
  return recoverable
    ? CHUNK_VALIDATION_FAILED_REASON
    : CHUNK_VALIDATION_EXHAUSTED_REASON;
}

/**
 * Render the untrusted server `detail` as a log suffix, or `""` when there is
 * nothing safe left to say.
 *
 * Sanitize BEFORE truncating: stripping first means `MAX_LOGGED_DETAIL_CHARS`
 * caps the characters that are actually printed rather than budgeting room for
 * bytes that were about to be removed. A detail that is only control characters
 * therefore collapses to `""` and is omitted entirely — the suffix is never
 * emitted for an empty payload, so an absent detail and a fully-stripped one
 * read identically in the log instead of printing a hollow `(server detail: )`.
 * No redaction marker is emitted: this drops terminal-control noise from a
 * diagnostic string, it does not redact sensitive content, and a marker would
 * imply a meaning-bearing value was withheld.
 */
function formatServerDetailSuffix(detail: string | undefined): string {
  const sanitized =
    detail === undefined
      ? undefined
      : sanitizeUntrustedServerText(detail, MAX_LOGGED_DETAIL_CHARS);
  return sanitized ? ` (server detail: ${sanitized})` : "";
}

/**
 * The `details.reason` values this lane DISCRIMINATES on, as opposed to the ones
 * it only echoes into a log. Two producers, deliberately: `summarizeParseIssues`
 * (`apps/api/lib/desktop-agent-sessions-parse-guards.ts`) derives the first from
 * a PAYLOAD parse, and `requireComputeTargetId`
 * (`apps/api/app/desktop/route-helpers.ts`) sends the second before the body is
 * read at all.
 *
 * Deliberately a near-empty set: the server's vocabulary is a diagnostic an
 * operator reads, and every value absent from here — including one a newer API
 * invents — keeps the shape-derived classification unchanged, so a version-
 * skewed peer can never steer this lane's retry behaviour.
 *
 * Every member is lane-wide; {@link isLaneWideValidationDetail} is derived from
 * this object rather than listing them again, so a member added here cannot be
 * left out of the classification by omission.
 */
export const ValidationFailureDetail = {
  /**
   * The batch's declared `schemaVersion` failed the server's parse. That is a
   * property of THIS DESKTOP BUILD, identical for every batch it will ever
   * send, and no row can be at fault for it — so it is charged to no session
   * and cleared only by a desktop or server upgrade.
   */
  SchemaVersionInvalid: "schema_version_invalid",
  /**
   * ISS-8734: the `computeTargetId` this lane sends was absent, blank, or not a
   * UUID. The desktop does not mint that id — it reads it off the relay hello
   * ack (`parseDesktopHelloAck`, which accepts any non-empty string) — so a
   * malformed one is identical for every batch until the connection is
   * re-established, and no row can be at fault for it.
   */
  ComputeTargetIdInvalid: DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID,
} as const;

export type ValidationFailureDetail =
  (typeof ValidationFailureDetail)[keyof typeof ValidationFailureDetail];

const LANE_WIDE_VALIDATION_DETAILS = Object.values(ValidationFailureDetail);

/**
 * The lane-wide member the server's reason names, or `undefined` for every
 * other value — including the omission an older API sends.
 *
 * Derived from {@link ValidationFailureDetail} rather than spelled as its own
 * list: a second inventory of the same members is the one that silently falls
 * behind, and a member missing from it would compile, miss the lane-wide arm,
 * and be charged to rows instead. Matching by value also returns the member at
 * its own type, so the caller reaches the exhaustive label map below without a
 * cast.
 */
export function laneWideValidationDetail(
  detail?: string
): ValidationFailureDetail | undefined {
  return LANE_WIDE_VALIDATION_DETAILS.find((member) => member === detail);
}

/**
 * Why the lane is deferring, per lane-wide reason. An exhaustive `Record` on
 * purpose: a new {@link ValidationFailureDetail} member fails `tsc` here rather
 * than silently logging a defer whose stated cause is the wrong one.
 */
const LANE_WIDE_DEFER_CLAUSE: Record<ValidationFailureDetail, string> = {
  [ValidationFailureDetail.SchemaVersionInvalid]:
    "the server rejected the batch SCHEMA VERSION, not any session in it, so this is lane-wide and every retry budget is left intact until one side is upgraded",
  [ValidationFailureDetail.ComputeTargetIdInvalid]:
    "the server rejected the lane's computeTargetId, not any session in it, so this is lane-wide and every retry budget is left intact until the connection is re-established",
};

/**
 * Park the whole batch behind the standard rejection backoff WITHOUT charging
 * any session's budget.
 *
 * Routed through the shared bounded fold with `countsToward: false`: no counter
 * is written and no id can dead-letter, so `maxConsecutive` and `recoverable`
 * are inert here and exist only to satisfy the shared config.
 *
 * ISS-8610 moved the lane's three genuinely LANE-WIDE environmental classes
 * (`unauthenticated`, `target_not_owned`, `transport_unavailable`) off this
 * shape and onto `deferLaneEnvironmental`, precisely because a defer with no
 * clock and no terminal is invariant 5's defect. This one stays where it is: a
 * batch-wide validation defer is a fact about THIS payload, not about the world,
 * so it has no lane run to open and belongs to the collaborator this module
 * already owns — which also logs the outcome.
 *
 * Nothing durable is recorded: `recordOutboxOnDefer` is false and no id
 * dead-letters, so this class writes no outbox `last_error` and therefore has no
 * entry in {@link isValidationFailureReason} — a lane-wide defer must not resume
 * as a consecutive validation rejection.
 */
function deferLaneWide(
  input: ValidationFailureInput,
  deps: ValidationFailureDeps,
  detailSuffix: string,
  laneWideDetail: ValidationFailureDetail
): void {
  const { syncMode, ids, payloadBytes } = input;
  deps.applyBoundedFold({
    ids,
    syncMode,
    payloadBytes,
    counter: deps.counter,
    maxConsecutive: MAX_CONSECUTIVE_VALIDATION_FAILED,
    reason: laneWideDetail,
    recoverable: true,
    backoffMs: VALIDATION_FAILED_BACKOFF_MS,
    recordOutboxOnDefer: false,
    countsToward: false,
    deferLabel:
      `rejected as validation_failed${detailSuffix} — ` +
      LANE_WIDE_DEFER_CLAUSE[laneWideDetail],
  });
}
