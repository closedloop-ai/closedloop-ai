/**
 * @file sync-failure-diagnostic.ts
 * @description ISS-7248 — the record a FAILED `POST /desktop/agent-sessions/sync`
 * attempt leaves behind.
 *
 * Two constraints decide its shape, and they pull apart:
 *
 * 1. It goes to the DURABLE local sink (`gatewayLog` → the rotating `main.log`),
 *    not a cloud path. Every cloud-bound path this process owns is lossy exactly
 *    when syncs fail, and a record that evaporates under load is worse than none
 *    because its absence reads as "no failure".
 * 2. Session ids may not ride the `sync.batch` span — the PRD-468/FEA-1981
 *    transport-health guardrail is counts/bytes/closed-enums only. This module
 *    does not widen it, so the ids that make a poisoned record diagnosable live
 *    here and never cross the wire.
 *
 * `batchId` stitches the halves back together. It is the client-generated
 * `AgentSessionSyncBatch.batchId` the request body already carries, not a new
 * identifier.
 *
 * ONE ATTEMPT = one `sendBatch` that did not come back accepted (a rejected ack
 * or a thrown transport error; mutually exclusive per call, which is what makes
 * "exactly one record per failed attempt" a property of the control flow). The
 * classes that fail BEFORE the transport (serialization, unhydratable,
 * locally-oversized) or AFTER a 2xx (`ack_clear_failed`, `ack_omitted`) are not
 * attempts: there is no batch id to join on and no server half to join to.
 *
 * `app.installation.id` and `service.version` are deliberately absent — they
 * ride every desktop span as OTel Resource attributes, and this record is read
 * on the installation it describes. `app.organization.id` is the exception: the
 * desktop Resource omits org identity, so it is carried here and nowhere else.
 */

import {
  SyncLane,
  SyncPayloadShaping,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import type { DesktopAgentSessionsAckReason } from "../cloud/cloud-protocol.js";
import { UNKNOWN_ACK_REASON } from "../cloud/cloud-protocol.js";
import type {
  DesktopSyncBatchOutcome,
  SessionSyncBatchEvent,
} from "../telemetry/app-otel-runtime.js";

/** Bump when a field's MEANING changes, never for an additive one. */
export const SYNC_FAILURE_DIAGNOSTIC_SCHEMA = "sync.failure.v1" as const;

/** Lets records be grepped out of `main.log` without JSON-parsing every line. */
export const SYNC_FAILURE_DIAGNOSTIC_PREFIX = "sync-failure-diagnostic ";

/**
 * Headroom, not a live limit (a batch holds at most ten sessions) — but an
 * unbounded list built from queue contents is the growth shape
 * `main/sync/AGENTS.md` invariant 10 forbids.
 */
export const MAX_DIAGNOSTIC_SESSION_IDS = 50;

/** The two outcomes a FAILED attempt can have; `success` is not a failure. */
export type SyncFailureOutcome =
  | typeof DesktopSyncBatchOutcome.Failure
  | typeof DesktopSyncBatchOutcome.DeadLetter;

/**
 * Every field is an id, a count, a size, or a closed enum member — no field a
 * transcript, prompt, or path could occupy. That is a property of the TYPE, not
 * of the callers; `sync-failure-diagnostic.test.ts` fails if it stops holding.
 */
export type SyncFailureDiagnostic = {
  schema: typeof SYNC_FAILURE_DIAGNOSTIC_SCHEMA;
  /** The join key: the batch id this attempt sent in the request body. */
  batchId: string;
  lane: SyncLane;
  outcome: SyncFailureOutcome;
  reason: SyncReason;
  /** Serialized wire size of the payload that failed. */
  payloadBytes: number;
  /** Sessions the failed batch carried. */
  sessionCount: number;
  /** Ids of the sessions the failed batch carried, capped and never content. */
  sessionIds: string[];
  /**
   * Ids the cap dropped from {@link sessionIds}. Present ONLY when ids were
   * actually dropped — a `0` on every healthy record would make the field
   * unreadable as the exception signal it is.
   */
  sessionIdsOmitted?: number;
  /** How the payload was reshaped to fit the wire cap before it was sent. */
  payloadShaping: SyncPayloadShaping;
  /**
   * ISS-7265: the chunk POSITION {@link payloadShaping} gave up when a strip
   * outranked it. Present ONLY when the two disagree — otherwise it would
   * restate `payloadShaping` on every record and stop reading as the recovery
   * it is. Without it the position is unrecoverable for exactly the sessions an
   * operator is most likely to be diagnosing: an oversized session that was
   * both stripped AND chunked reports the strip on every attempt.
   */
  chunkPosition?: SyncPayloadShaping;
  /**
   * ISS-7265: how many sessions in this batch shipped WITHOUT their
   * activity-segment tiling, which the producer strips to fit an oversized base
   * against a server that cannot merge multi-part tilings.
   *
   * Carried as its own count rather than left to {@link payloadShaping} alone,
   * which has one slot and two axes to report: a stripped payload that is also
   * chunked would otherwise have to pick one. Present ONLY when a strip actually
   * happened — a `0` on every healthy record makes the exception unreadable.
   */
  tilingStrippedSessionCount?: number;
  /**
   * 1-indexed consecutive-failure count for the hardest-hit row in this batch,
   * so `> 1` reads as "this is a retry of a batch that already failed".
   *
   * OMITTED, never defaulted to 1, when this failure class burns no retry
   * budget (`unauthenticated`, `target_not_owned`, `feature_disabled`): those
   * defer with every budget intact, so no attempt was counted and a fabricated
   * `1` would read as a measured first failure.
   *
   * ISS-8605: for the ENVIRONMENTAL classes (`ingestion_failed`, `rate_limited`,
   * `ack_timeout`) this is a TALLY, not a proximity-to-give-up signal. Those
   * classes no longer have a consecutive-failure budget, so a large value here
   * means only "the world has been broken a while" — at the shared 30s cadence a
   * row can reach the high hundreds inside one 24h outage without ever being
   * close to a terminal outcome. What actually bounds them is the durable
   * `lane_stalled_since` wall clock, which this record does NOT carry. Do not
   * alert on this number for those classes, and do not read it as proximity to a
   * dead-letter the way a budgeted class's attempt count can be read.
   */
  attempt?: number;
  /** Round-trip time, omitted when the attempt never reached the wire. */
  latencyMs?: number;
  /** Authenticated org, absent when signed out. Never leaves the machine. */
  organizationId?: string;
};

export type BuildSyncFailureDiagnosticInput = {
  batchId: string;
  lane: SyncLane;
  outcome: SyncFailureOutcome;
  reason: SyncReason;
  payloadBytes: number;
  sessionIds: readonly string[];
  payloadShaping: SyncPayloadShaping;
  chunkPosition?: SyncPayloadShaping;
  tilingStrippedSessionCount?: number;
  attempt?: number;
  latencyMs?: number;
  organizationId?: string | null;
};

/**
 * Pure, so the contract is testable without a service, socket, or filesystem.
 * Counts are floored and non-finite input coerced rather than shipped — a `NaN`
 * byte total is how an incident gets debugged against a number nobody measured.
 */
export function buildSyncFailureDiagnostic(
  input: BuildSyncFailureDiagnosticInput
): SyncFailureDiagnostic {
  const sessionIds = input.sessionIds.slice(0, MAX_DIAGNOSTIC_SESSION_IDS);
  const omitted = input.sessionIds.length - sessionIds.length;
  const tilingStripped = safeCount(input.tilingStrippedSessionCount ?? 0);
  return {
    schema: SYNC_FAILURE_DIAGNOSTIC_SCHEMA,
    batchId: input.batchId,
    lane: input.lane,
    outcome: input.outcome,
    reason: input.reason,
    payloadBytes: safeCount(input.payloadBytes),
    sessionCount: input.sessionIds.length,
    sessionIds,
    ...(omitted > 0 ? { sessionIdsOmitted: omitted } : {}),
    payloadShaping: input.payloadShaping,
    // ISS-7265: only when the one-slot shaping value masked a different chunk
    // position — repeating it otherwise would make the recovery unreadable.
    ...(input.chunkPosition === undefined ||
    input.chunkPosition === input.payloadShaping
      ? {}
      : { chunkPosition: input.chunkPosition }),
    // ISS-7265: emitted only on the branch where a strip actually happened. A
    // count that appeared on every record would inflate the payload-size signal
    // onto the batches it does not describe.
    ...(tilingStripped > 0
      ? { tilingStrippedSessionCount: tilingStripped }
      : {}),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.latencyMs === undefined
      ? {}
      : { latencyMs: safeCount(input.latencyMs) }),
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
  };
}

/** Serialize one record as the single durable log line the sink receives. */
export function formatSyncFailureDiagnostic(
  diagnostic: SyncFailureDiagnostic
): string {
  return `${SYNC_FAILURE_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`;
}

/**
 * Every per-class failure COUNTER the session lane keeps, by the class that
 * writes it.
 *
 * ISS-8605: not all of these are budgets any more. `ackTimeout`, `rateLimited`
 * and `ingestionFailed` are unbounded tallies for environmental classes that
 * dead-letter on a wall clock instead of a count; only `validationFailed`,
 * `transportTimeout`, `transportError` and `ackOmitted` still bound anything.
 *
 * `transportTimeout` is NOT one of the service's own counter maps — it lives
 * inside `TransportTimeoutBudget`, which hands it to the fold through
 * `foldPolicy()`. It is named here explicitly because a diagnostic that
 * enumerated only the service's fields would silently miss the one class whose
 * whole purpose is to explain an unanswered request.
 */
export type SyncFailureBudgets = {
  ackTimeout: ReadonlyMap<string, number>;
  transportTimeout: ReadonlyMap<string, number>;
  rateLimited: ReadonlyMap<string, number>;
  ingestionFailed: ReadonlyMap<string, number>;
  validationFailed: ReadonlyMap<string, number>;
  ackOmitted: ReadonlyMap<string, number>;
  transportError: ReadonlyMap<string, number>;
};

/**
 * Which budget each reason spends, or `null` for the classes that spend none.
 *
 * Exhaustive over {@link SyncReason} by type, so a reason added to the contract
 * fails `tsc` here until someone decides what it charges — the alternative is a
 * default branch that quietly attributes a new class to the wrong budget.
 *
 * The `null`s are the load-bearing half. `unauthenticated`, `target_not_owned`
 * and `feature_disabled` defer with every budget intact; `transport_unavailable`
 * folds with `countsToward: false` and never writes its counter; the rest are
 * either pre-send drops or belong to one of the other four lanes. Reading ANY
 * counter for those would report a number this failure did not cause — a session
 * carrying an old `ingestion_failed` charge would make an auth-loss deferral look
 * like a burned retry.
 */
const BUDGET_FOR_REASON: Record<SyncReason, keyof SyncFailureBudgets | null> = {
  [SyncReason.AckClearFailed]: null,
  [SyncReason.AckOmitted]: "ackOmitted",
  [SyncReason.AckTimeout]: "ackTimeout",
  [SyncReason.GenerationConflict]: null,
  [SyncReason.PartConflict]: null,
  [SyncReason.ProtocolUnsupported]: null,
  [SyncReason.RateLimited]: "rateLimited",
  [SyncReason.SessionMissing]: null,
  [SyncReason.SourceMissing]: null,
  [SyncReason.TransportTimeout]: "transportTimeout",
  [SyncReason.TransportUnavailable]: null,
  [SyncReason.IngestionFailed]: "ingestionFailed",
  [SyncReason.UploadConflict]: null,
  [SyncReason.ValidationFailed]: "validationFailed",
  [SyncReason.FeatureDisabled]: null,
  [SyncReason.LocallyOversized]: null,
  [SyncReason.TargetNotOwned]: null,
  [SyncReason.TransportError]: "transportError",
  [SyncReason.Unauthenticated]: null,
  [SyncReason.Unhydratable]: null,
  // ISS-9418: a lane give-up charges NOTHING, and that is the invariant rather
  // than a default. An environmental give-up is not item-attributable
  // (`main/sync/AGENTS.md` invariant 4) - the world was broken, not these bytes
  // - so reading any counter for it would report a number this failure did not
  // cause, and dead-lettering the rows it owes is the ISS-6883 / ISS-7730 defect
  // class that lost 40,634 events.
  [SyncReason.LaneGaveUp]: null,
  // ISS-11389: an unreadable local store is lane-wide, so it charges no item
  // budget either (invariant 4).
  [SyncReason.LocalReadFailed]: null,
};

/**
 * The budget this reason charges, or `null` when it charges none.
 *
 * Guarded with `Object.hasOwn` rather than a bare lookup: `reason` originates in
 * an ack fold whose value a version-skewed cloud can influence, and a bare `{}`
 * index on such a key is the prototype-pollution shape the repo bans for
 * dispatch tables.
 */
export function budgetForSyncReason(
  reason: SyncReason,
  budgets: SyncFailureBudgets
): ReadonlyMap<string, number> | null {
  if (!Object.hasOwn(BUDGET_FOR_REASON, reason)) {
    return null;
  }
  const key = BUDGET_FOR_REASON[reason];
  return key ? budgets[key] : null;
}

/**
 * The highest consecutive-failure count any of `ids` carries in `counter` — a
 * batch is exactly as retried as its hardest-hit row.
 */
export function highestFailureCount(
  ids: readonly string[],
  counter: ReadonlyMap<string, number> | null
): number {
  if (!counter) {
    return 0;
  }
  let highest = 0;
  for (const id of ids) {
    const count = counter.get(id) ?? 0;
    if (count > highest) {
      highest = count;
    }
  }
  return highest;
}

/**
 * Which attempt this failure is, reconciled across the reason fold.
 *
 * Reading the counters AFTER the fold is not sufficient, and the case it misses
 * is the one that matters most: the fold that EXHAUSTS a budget dead-letters the
 * row and calls `clearFailureStateForId`, which wipes the very counter that
 * proves how hard the lane tried. Reporting `undefined` there would blank the
 * attempt number on precisely the record an operator opens to ask "did the
 * retries ever land?".
 *
 * So a dead-letter reports the count the fold CONSUMED (`before + 1`, exactly
 * what `foldOneId` computed before clearing), and the two are combined with
 * `Math.max` because one id in a batch can dead-letter while a sibling merely
 * defers — taking either alone would under-report the batch.
 *
 * `undefined` survives as the honest answer for a class that burned no budget
 * at all (`unauthenticated`, `target_not_owned`, `feature_disabled`): those
 * defer with every budget intact, and a fabricated `1` would read as a measured
 * first failure.
 */
export function resolveFoldedAttempt(input: {
  before: number;
  after: number;
  deadLetteredThisAttempt: boolean;
}): number | undefined {
  const consumed = input.deadLetteredThisAttempt ? input.before + 1 : 0;
  const highest = Math.max(input.after, consumed);
  return highest > 0 ? highest : undefined;
}

/**
 * How the payload that is about to be (or has just been) sent was reshaped.
 *
 * `chunkTailDiscarded` wins over the plain tail case on purpose: "one chunk of
 * this session failed" and "this session's whole in-flight sequence was
 * abandoned and re-prepares from chunk 0" are different incidents, and folding
 * them together erases the one a reader needs.
 *
 * ISS-7265: `activityTilingStripped` outranks the chunk POSITION values — a
 * position says WHERE in a sequence a whole payload sat, a strip says the
 * payload was not whole, and only the second is actionable during a
 * payload-size investigation. It stays BELOW `chunkTailDiscarded`, the one
 * value naming an abandoned in-flight sequence.
 *
 * Outranking is a real loss on the one-slot attribute, and the strip-and-chunk
 * case is not hypothetical: the ISS-4578 fallback re-chunks the tiling-less
 * session, so EVERY attempt for such a session would otherwise report the strip
 * and never its position. {@link resolveChunkPayloadShaping} is therefore kept
 * separately callable and the durable record carries its answer in
 * {@link SyncFailureDiagnostic.chunkPosition} — that, not the strip COUNT, is
 * what makes the chunk axis survive.
 */
export function resolveSyncPayloadShaping(input: {
  drainingPendingChunkTail: boolean;
  hasPinnedChunkTail: boolean;
  chunkTailDiscarded: boolean;
  activityTilingStripped: boolean;
}): SyncPayloadShaping {
  if (input.chunkTailDiscarded) {
    return SyncPayloadShaping.ChunkTailDiscarded;
  }
  if (input.activityTilingStripped) {
    return SyncPayloadShaping.TilingStripped;
  }
  return resolveChunkPayloadShaping(input);
}

/**
 * The chunk-POSITION axis on its own, blind to the strip.
 *
 * This is `resolveSyncPayloadShaping`'s pre-ISS-7265 body, unchanged, so the
 * position a stripped payload masks is still computable from the same inputs.
 */
export function resolveChunkPayloadShaping(input: {
  drainingPendingChunkTail: boolean;
  hasPinnedChunkTail: boolean;
  chunkTailDiscarded: boolean;
}): SyncPayloadShaping {
  if (input.chunkTailDiscarded) {
    return SyncPayloadShaping.ChunkTailDiscarded;
  }
  if (input.drainingPendingChunkTail) {
    return SyncPayloadShaping.ChunkedTail;
  }
  return input.hasPinnedChunkTail
    ? SyncPayloadShaping.ChunkedHead
    : SyncPayloadShaping.Whole;
}

/**
 * Both shaping axes from one set of inputs.
 *
 * Every failure path needs the pair, and computing them at the call site meant
 * spelling the same three chunk-state expressions twice — where the two copies
 * can drift into describing different attempts of the same send.
 */
export function resolveSyncPayloadShapingPair(input: {
  drainingPendingChunkTail: boolean;
  hasPinnedChunkTail: boolean;
  chunkTailDiscarded: boolean;
  activityTilingStripped: boolean;
}): {
  payloadShaping: SyncPayloadShaping;
  chunkPosition: SyncPayloadShaping;
} {
  return {
    payloadShaping: resolveSyncPayloadShaping(input),
    chunkPosition: resolveChunkPayloadShaping(input),
  };
}

/** The two sinks one failed attempt is reported to. */
export type SyncFailureReportDeps = {
  /**
   * The `sync.batch` span seam. Optional because it is optional on the service;
   * a runtime that never started leaves it unwired, and the durable record must
   * still be written — that is the whole point of having two sinks.
   */
  emitTelemetry?: (event: SessionSyncBatchEvent) => void;
  /** The DURABLE sink: one line into the rotating desktop main log. */
  writeDurableRecord: (line: string) => void;
};

export type ReportSyncAttemptFailureInput = BuildSyncFailureDiagnosticInput;

/**
 * Report ONE failed sync attempt to both sinks.
 *
 * Exactly one call per attempt, and every failure path calls it: the two are
 * the same obligation seen from either side, and splitting the telemetry event
 * from the durable record across separate call sites is how one of them
 * silently stops being emitted.
 *
 * The durable write goes FIRST. If the span seam throws (it is wrapped
 * best-effort today, but that is the runtime's promise, not this module's), the
 * record that survives a failing cloud must already be on disk.
 */
export function reportSyncAttemptFailure(
  deps: SyncFailureReportDeps,
  input: ReportSyncAttemptFailureInput
): void {
  const diagnostic = buildSyncFailureDiagnostic(input);
  deps.writeDurableRecord(formatSyncFailureDiagnostic(diagnostic));
  deps.emitTelemetry?.({
    outcome: diagnostic.outcome,
    // ISS-8589: named HERE, by the site that already knows it for the durable
    // record. Until now the session lane's span was attributed only because the
    // composition re-stamps `session_metadata` over every event it forwards, so
    // any other caller of this lane-generic seam emitted an unattributed span.
    lane: diagnostic.lane,
    payloadBytes: diagnostic.payloadBytes,
    reason: diagnostic.reason,
    batchId: diagnostic.batchId,
    sessionCount: diagnostic.sessionCount,
    payloadShaping: diagnostic.payloadShaping,
    // ISS-7265: the strip count is the span's ONLY degradation signal when
    // `payloadShaping` reports an abandoned sequence instead. It is a count, so
    // it stays inside the transport-health guardrail this module documents.
    ...(diagnostic.tilingStrippedSessionCount === undefined
      ? {}
      : {
          tilingStrippedSessionCount: diagnostic.tilingStrippedSessionCount,
        }),
    ...(diagnostic.attempt === undefined
      ? {}
      : { attempt: diagnostic.attempt }),
    ...(diagnostic.latencyMs === undefined
      ? {}
      : { latencyMs: diagnostic.latencyMs }),
  });
}

/** Floor a measured count at 0 and refuse to pass a non-finite value through. */
function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** What the session-metadata lane must supply to report one failed attempt. */
export type SessionMetadataAttemptFailureDeps = SyncFailureReportDeps & {
  /** Org id at report time, or undefined on a single-player/unauthenticated install. */
  getOrganizationId: () => string | undefined;
  /**
   * Highest consecutive-failure count these ids carry in the budget THIS reason
   * charges. Supplied by the service because the counters are its state.
   */
  failureCountFor: (reason: SyncReason, ids: readonly string[]) => number;
};

/**
 * Report one failed session-metadata sync attempt, folding the before/after
 * failure counts into the attempt number the record carries.
 *
 * Lives here rather than on the service because every part of it — the fold, the
 * two sinks, the lane — is this module's concern; the service owns only the
 * counters, which arrive as `failureCountFor`.
 */
export function reportSessionMetadataAttemptFailure(
  deps: SessionMetadataAttemptFailureDeps,
  input: Omit<
    ReportSyncAttemptFailureInput,
    "lane" | "attempt" | "organizationId"
  > & {
    /** Highest failure count these ids carried BEFORE this attempt's fold. */
    attemptBefore: number;
    /**
     * Computed by the caller, which already holds `DesktopSyncBatchOutcome` as a
     * value. Keeping it out of here leaves this module's import of the telemetry
     * runtime TYPE-ONLY, so the durable-diagnostic path does not pull the OTel
     * SDK in at runtime.
     */
    deadLetteredThisAttempt: boolean;
  }
): void {
  const { attemptBefore, deadLetteredThisAttempt, ...record } = input;
  reportSyncAttemptFailure(
    {
      emitTelemetry: deps.emitTelemetry,
      writeDurableRecord: deps.writeDurableRecord,
    },
    {
      ...record,
      lane: SyncLane.SessionMetadata,
      attempt: resolveFoldedAttempt({
        before: attemptBefore,
        after: deps.failureCountFor(record.reason, record.sessionIds),
        deadLetteredThisAttempt,
      }),
      organizationId: deps.getOrganizationId(),
    }
  );
}

/**
 * The batch's effective consecutive-failure count for `reason`:
 * {@link budgetForSyncReason} composed with {@link highestFailureCount}.
 *
 * Composed here rather than at the call site because that composition is the
 * ONLY way either half is used — the budget lookup is meaningless without the
 * fold over ids, and the fold has nothing to read without the lookup. Keeping
 * the pair together also keeps the `null`-budget contract (a reason that charges
 * no budget folds to 0) in the module that defines it.
 */
export function failureCountForReason(
  reason: SyncReason,
  ids: readonly string[],
  budgets: SyncFailureBudgets
): number {
  return highestFailureCount(ids, budgetForSyncReason(reason, budgets));
}

/**
 * ISS-8595: the closed `sync.reason` value a rejected ack reports.
 *
 * Every member of `DesktopAgentSessionsAckReason` is spelled identically in
 * {@link SyncReason} — that is the contract those two consts are held to — so
 * this is the identity map everywhere except one case. `UNKNOWN_ACK_REASON` is
 * deliberately NOT a telemetry reason: `sync.reason` is a closed enum, and a
 * value the desktop synthesized for "the cloud named something newer" has no
 * agreed spelling on the receiving side. Emitting it raw would put an
 * out-of-enum string on a validated attribute, which is dropped, not recorded —
 * the failure would go MISSING from the SLO rather than merely be labelled
 * coarsely.
 *
 * So it folds to the generic `ingestion_failed`, following the repo's
 * cross-repo rule for unknown classifications. The distinction is not lost: the
 * durable outbox keeps its own `unknown_ack_reason` spelling, and the gateway
 * log names what the peer actually called it.
 *
 * Uncast on purpose: the narrowed return below only typechecks while every ack
 * reason is also a `SyncReason`, so this signature is the compile-time guard on
 * that agreement rather than an assertion papering over it.
 */
export function syncReasonForAckReason(
  reason: DesktopAgentSessionsAckReason | typeof UNKNOWN_ACK_REASON
): SyncReason {
  return reason === UNKNOWN_ACK_REASON ? SyncReason.IngestionFailed : reason;
}
