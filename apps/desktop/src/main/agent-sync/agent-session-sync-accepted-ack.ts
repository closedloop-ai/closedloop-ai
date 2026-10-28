/**
 * @file agent-session-sync-accepted-ack.ts
 * @description Goal stage 2 (atomic row-level ack): the ACCEPTED-ack processing
 * for the session sync lane, extracted from the grandfathered (shrink-only)
 * `agent-session-sync-service.ts` in the same collaborator style as the
 * failure-side folds (`agent-session-sync-ack-fold.ts`,
 * `agent-session-sync-transport-error-fold.ts`).
 *
 * The contract this module owns:
 *
 * - Ack processing is keyed on the ids the SERVER returned
 *   (`acceptedSessionIds`), never on the ids the client believes it sent. An
 *   older server (or a batch that did not request the echo) omits the field —
 *   that absence means the legacy whole-batch contract, so every sent id is
 *   acked. A present echo is intersected with the sent set: an omitted id is
 *   NOT acked, and an id outside this batch can never clear a row it did not
 *   carry.
 * - The durable outbox clear IS the ack processing: one AWAITED `deleteMany`
 *   transaction, committed BEFORE any in-memory advance. A kill between
 *   ack-receipt and clear therefore cannot exist as separate steps — either
 *   the clear committed (the rows are durably acked) or it did not (the rows
 *   are still `pending`; the next pass re-sends and the server dedupes).
 * - A FAILED durable clear (db-host unavailable) aborts ack processing with
 *   every retry budget intact — a lane-wide local condition per
 *   `main/sync/AGENTS.md` invariant 4, never a payload verdict. Measured, not
 *   silent: a loud error log plus the `ack_clear_failed` telemetry reason
 *   bound and count the acked-work-re-sent window.
 * - Rows the echo OMITS stay queued on the bounded `ack_omitted` budget
 *   (row-attributable — their neighbors acked in the same request): deferred
 *   with backoff while budget remains, then a dead-letter that is recoverable
 *   only while `MAX_ACK_OMITTED_DEAD_LETTERS` re-drive cycles remain — the
 *   ISS-5090 second-order bound, without which recovery's budget reset would
 *   re-drive a permanently-omitted row forever. This is
 *   a LIVE path, not a future one: the server derives the echo from the ids
 *   `upsertSessions` actually persisted, and it deliberately skips a slice it
 *   will not write (a foreign chunk, whose revision does not match the pending
 *   assembly) while still accepting the batch.
 */
import {
  SyncPayloadShaping,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  DesktopSyncBatchOutcome,
  type SessionSyncBatchEvent,
} from "../telemetry/app-otel-runtime.js";
import {
  type FreshestSessionLagAnomaly,
  resolveFreshestSessionLagMs,
} from "./agent-session-freshness-lag.js";
import { reportUnsendableComponentUsage } from "./agent-session-payload-preparation.js";
import type { BoundedFailureFoldConfig } from "./agent-session-sync-ack-fold.js";
import {
  ACK_OMITTED_BACKOFF_MS,
  MAX_ACK_OMITTED_DEAD_LETTERS,
  MAX_CONSECUTIVE_ACK_OMITTED,
} from "./agent-session-sync-backoff-policy.js";
import type { UnsendableComponentUnits } from "./agent-session-sync-payload.js";
import type { OutboxClearVerdict } from "./outbox-clear-result.js";
import type { PriorityUploadClaim } from "./priority-upload-claims.js";

export type AcceptedAckInput = {
  syncMode: AgentSessionSyncMode;
  /** The ids this client sent in the acked batch. */
  ids: string[];
  sessionCount: number;
  payloadBytes: number;
  latencyMs: number;
  /**
   * Whether this ack answered a NON-final chunk of an oversized session — the
   * session dequeues (and clears) only on its final chunk.
   */
  hasMoreChunks: boolean;
  /** Remaining chunk count for the log suffix; null when not chunk-draining. */
  remainingChunks: number | null;
  /** The server's per-row echo, when the request gated it open. */
  acceptedSessionIds?: readonly string[];
  /**
   * ISS-7496: newest parseable `updatedAt` among the sessions this batch put on
   * the wire, in epoch ms, read at send time off the payload itself.
   *
   * `null` means the batch carried none — a corrupt local row, since `updatedAt`
   * is required on the wire type. `undefined` means this caller did not measure
   * one, which is the silent arm: only a measured impossibility is a finding.
   */
  freshestUpdatedAtMs?: number | null;
  /**
   * ISS-7265: the ids of the sessions this batch put on the wire WITHOUT their
   * activity tiling, read at send time off the payload itself.
   *
   * Ids and not a count, because the harm this measures is a session being
   * permanently DEQUEUED while the cloud holds no tiling for it, and only the
   * server's echo says which sessions that actually happened to. `undefined`
   * means this caller measured nothing; `[]` means it measured none.
   */
  tilingStrippedSessionIds?: readonly string[];
  /**
   * ISS-6999: the component-usage rows the session in this batch shipped
   * WITHOUT, measured at prepare time against the bytes that actually went out.
   *
   * Present only on the FINAL chunk of a sequence that skipped something, so
   * reaching the delivery path with it set means those rows are now permanently
   * absent from the cloud. `undefined` means either nothing was skipped or this
   * caller never measured — both correctly report nothing.
   */
  unsendableComponentUnits?: UnsendableComponentUnits;
  /**
   * ISS-10332: the priorities the sent sessions carried, read at send time off
   * the payload itself (`priorityUploadClaims`).
   */
  priorityUploadClaims?: readonly PriorityUploadClaim[];
};

/**
 * What the send frame measured off the payload it sent, for the ack and failure
 * paths the ack itself does not echo. ISS-7248: `batchId` joins this attempt to
 * its server-side half, and `drainingPendingChunkTail` says whether it drained an
 * already-open chunk tail.
 */
export type SentBatchAttempt = {
  batchId: string;
  drainingPendingChunkTail: boolean;
  /** ISS-7265: which sent sessions shipped without their tiling. */
  tilingStrippedSessionIds: readonly string[];
  /** ISS-7496: the sent payload's newest `updatedAt`; null when it had none. */
  freshestUpdatedAtMs: number | null;
  unsendableComponentUnits?: UnsendableComponentUnits;
  priorityUploadClaims: readonly PriorityUploadClaim[];
};

/**
 * Assemble {@link AcceptedAckInput} from what the send frame holds. Lives with
 * its consumer rather than in the grandfathered sync-service file, which is
 * shrink-only — the same reason this whole module was extracted.
 *
 * `acceptedSessionIds` is OMITTED rather than set to `undefined` when the server
 * sent no echo: absence is the legacy whole-batch contract, and a present-but-
 * undefined key would read the same to `splitAckedIds` only by luck.
 */
export function acceptedAckInput(source: {
  syncMode: AgentSessionSyncMode;
  ids: string[];
  sessionCount: number;
  payloadBytes: number;
  latencyMs: number;
  hasMoreChunks: boolean;
  /** Chunks still pinned behind this one; only meaningful mid-sequence. */
  pendingChunkCount: number | null;
  acceptedSessionIds?: readonly string[];
  attempt: Omit<SentBatchAttempt, "batchId" | "drainingPendingChunkTail">;
}): AcceptedAckInput {
  const { attempt, hasMoreChunks } = source;
  return {
    syncMode: source.syncMode,
    ids: source.ids,
    sessionCount: source.sessionCount,
    payloadBytes: source.payloadBytes,
    latencyMs: source.latencyMs,
    hasMoreChunks,
    remainingChunks: hasMoreChunks ? source.pendingChunkCount : null,
    ...(source.acceptedSessionIds
      ? { acceptedSessionIds: source.acceptedSessionIds }
      : {}),
    freshestUpdatedAtMs: attempt.freshestUpdatedAtMs,
    tilingStrippedSessionIds: attempt.tilingStrippedSessionIds,
    unsendableComponentUnits: attempt.unsendableComponentUnits,
    priorityUploadClaims: attempt.priorityUploadClaims,
  };
}

/**
 * The per-row failure/budget state a VERIFIED ack resets. Passed as the live
 * maps (the fold-module precedent) so the reset semantics live here with the
 * processing order, not as a dozen callbacks.
 */
export type AcceptedAckRowState = {
  /**
   * ISS-11427: the set-aside marker. The incremental feed re-sends a
   * dead-lettered session whenever it changes, and the verified ack that lands
   * it deletes the outbox row, so the marker would otherwise outlive the
   * delivery and the row would go on reporting a dead letter it no longer is.
   */
  deadLetteredIds: Map<string, number>;
  timeoutCountById: Map<string, number>;
  /**
   * FEA-1461: a successful ack resets the rate-limit counter and clears any
   * deferred-retry deadline, so a future rejection starts over at 1.
   */
  rateLimitedCountById: Map<string, number>;
  /** ISS-8595: the tally for an ack reason this build could not name. */
  unknownAckReasonCountById: Map<string, number>;
  ingestionFailedCountById: Map<string, number>;
  /**
   * ISS-7730: a verified ack is the strongest possible proof the lane is
   * reachable, so it ends any lane-wide stall run outright. No durable clear of
   * THIS clock is needed alongside it — the ack deletes the outbox row that
   * carried it. The lane-level ISS-9418 give-up is a different column on a row
   * the ack does not delete, so it is cleared explicitly through
   * `AcceptedAckDeps.clearLaneGiveUp`.
   */
  laneStalledSinceMsById: Map<string, number>;
  validationFailedCountById: Map<string, number>;
  /** Goal stage 2: the server has now confirmed this exact row. */
  ackOmittedCountById: Map<string, number>;
  /**
   * FEA-4375: a verified ack proves the row valid — drop any pending
   * validation-bisection flag; it is no longer a suspect.
   */
  validationBisectIds: Set<string>;
  /** FEA-3364: a future transport throw starts over at 1. */
  transportErrorCountById: Map<string, number>;
  /** ISS-5088: the refundable client-abort budget's per-id clear. */
  clearTransportTimeoutBudgetFor: (id: string) => void;
  nextRetryAfterMs: Map<string, number>;
  /**
   * FEA-3795: a verified ack is genuine forward progress — the progressive
   * dead-letter escalation restarts at the short base window.
   */
  deadLetterCountById: Map<string, number>;
  /** ISS-5090: only a verified ack refunds the chunk-validation allowance. */
  chunkValidationCycleById: Map<string, number>;
  /** Goal stage 2: likewise, only a verified ack refunds the ack-omitted one. */
  ackOmittedCycleById: Map<string, number>;
};

export type AcceptedAckDeps = {
  rowState: AcceptedAckRowState;
  /**
   * The awaited, success-reporting durable clear (`clearOutboxOnAck`).
   * ISS-7957: `deletedRowCount` is the rows the delete actually removed, OMITTED
   * when nothing measured one (a source with no outbox delegate, or a
   * version-skewed db-host peer that predates the field).
   */
  clearOutboxDurably: (ids: string[]) => Promise<OutboxClearVerdict>;
  /** Superseded-lifecycle guard values, re-read AFTER the clear await. */
  sourceStateGeneration: () => number;
  isStarted: () => boolean;
  /**
   * ISS-8116 (davetho / whitlockk review): the pass's IDENTITY-only predicate,
   * re-read after the tiling-debt and durable-clear awaits.
   *
   * The generation pair above cannot see a compute-target/account switch — that
   * is the whole finding of ISS-6067 and ISS-8116 — so the pre-await check in
   * `runSessionSyncPass` protected only ENTRY to this function. An identity that
   * moved while `recordTilingDebt` or `clearOutboxDurably` was outstanding still
   * reached the dequeue and the cursor persist below under the wrong key.
   *
   * Deliberately identity-only, without `shouldRun()`: the server already
   * accepted this batch, so a readiness drop must not discard its ack and force
   * a re-upload (see `SyncPassIdentityGuard.isCurrentSourceIdentity`).
   */
  isCurrentSourceIdentity: () => boolean;
  dequeue: (syncMode: AgentSessionSyncMode, ids: string[]) => void;
  /**
   * ISS-9418: clear this LANE's durable give-up
   * (`SessionFoldRunners.clearLaneGiveUp`). A verified ack clears it: the server
   * took the bytes, so the world is demonstrably no longer the problem, which is
   * the same evidence the per-row clocks reset on. Without it a lane that
   * recovers the NORMAL way — batches start being accepted again — keeps its
   * lane-run columns set indefinitely, because the only other clear is a
   * row-attributable rejection a healthy corpus may never produce.
   */
  clearLaneGiveUp: () => void;
  persistCursorIfCaughtUp: () => void;
  applyBoundedFold: (config: BoundedFailureFoldConfig) => void;
  deadLetteredCount: () => number;
  /**
   * The service-owned idle-cycle revisit reset (see
   * `resetDeadLetterRevisitAfterDrainedAck` on the service for why it exists).
   */
  resetDeadLetterRevisitAfterDrainedAck: () => void;
  queueSizes: () => { incremental: number; backfill: number };
  /**
   * Drop the pinned chunk tail (`pendingChunks = null`) so the still-queued
   * session re-prepares from chunk 0, mirroring the batch-failure and
   * capability-downgrade discards. Used when a NON-final chunk comes back
   * accepted-but-not-persisted.
   */
  discardPendingChunkTail: () => void;
  schedulePendingPartDrain: () => void;
  scheduleImmediateDrainIfReadyWorkRemains: () => void;
  emitTelemetry: (event: SessionSyncBatchEvent) => void;
  /**
   * ISS-7496: route an impossible freshness input to the monitored lane. Omitted
   * in contexts with no telemetry runtime; the attribute is dropped either way,
   * so a missing reporter costs the alert, never the batch.
   */
  reportFreshnessAnomaly?: (anomaly: FreshestSessionLagAnomaly) => void;
  /**
   * ISS-7265 AC3: hand the durable tiling-debt ledger this delivery's verdict —
   * which confirmed sessions left without their tiling (now owed) and which left
   * with it (debt settled). Optional so a context with no durable store drops
   * the bookkeeping rather than the ack.
   */
  recordTilingDebt?: (debt: {
    owed: string[];
    settled: string[];
  }) => Promise<void>;
  /**
   * ISS-10332: stop re-sending the priorities the CONFIRMED sessions carried.
   * Optional so a context with no durable store keeps re-sending them.
   */
  settlePriorityUploads?: (
    claims: readonly PriorityUploadClaim[]
  ) => Promise<void>;
  logInfo: (message: string) => void;
  logError: (message: string) => void;
};

/**
 * Process one accepted batch ack end to end: durable clear → in-memory
 * advance → omitted-row fold → log → self-continue → telemetry. The batch
 * Success event is emitted only when the server CONFIRMED at least one row
 * (ISS-6202), and the POST's own cost is reported exactly once regardless of
 * which event that leaves terminal ({@link createBatchCostLedger}); the caller's
 * failure branches never reach this function.
 */
export async function processAcceptedAck(
  input: AcceptedAckInput,
  deps: AcceptedAckDeps
): Promise<void> {
  const { hasMoreChunks } = input;
  const spendBatchCost = createBatchCostLedger(input);
  const split = splitAckedIds(input);
  if (hasMoreChunks && split.omittedIds.length > 0) {
    abandonUnpersistedChunkTail(input, split, deps, spendBatchCost);
    return;
  }
  let deadLetteredOmitted = false;
  // ISS-7957: the rows the durable clear actually removed. `undefined` means
  // UNMEASURED and is carried as an omission all the way to the event.
  let durablyClearedRows: number | undefined;
  if (hasMoreChunks) {
    // A non-final chunk dropped nothing: it acks a chunk, and the session
    // dequeues only on its final one. That is a MEASURED zero, not an absent
    // measurement — no clear was attempted and none was owed.
    durablyClearedRows = 0;
  } else {
    const advance = await advanceOnDurableClear(
      input,
      split,
      deps,
      spendBatchCost
    );
    if (!advance.advanced) {
      return;
    }
    deadLetteredOmitted = advance.deadLetteredOmitted;
    durablyClearedRows = advance.durablyClearedRows;
  }
  deps.logInfo(formatAckLine(input, split, deadLetteredOmitted, deps));
  if (hasMoreChunks) {
    deps.schedulePendingPartDrain();
  } else {
    // FEA-4375: an accepted batch is forward progress — self-continue.
    deps.scheduleImmediateDrainIfReadyWorkRemains();
  }
  // ISS-6202: Success is a claim that this batch PERSISTED something, so it is
  // gated on the server having confirmed at least one row. An accepted envelope
  // whose echo is empty confirmed nothing: `foldOmittedRows` has already emitted
  // the Failure/DeadLetter that describes what actually happened, and a
  // batch-level Success on top of it reported the same zero-persistence batch as
  // both a failure and forward progress — advancing accepted burn-down for work
  // no row acked. A legacy no-echo ack still acks every sent id, so this cannot
  // silence an older server. The POST's own cost rides whichever event is
  // terminal for this ack (see {@link createBatchCostLedger}), so gating Success
  // never removes the batch from byte burn-down or round-trip timing.
  if (split.ackedIds.length > 0) {
    deps.emitTelemetry({
      ...spendBatchCost(),
      outcome: DesktopSyncBatchOutcome.Success,
      ...resolveDeliveredStrip(input, split),
      // ISS-7401/ISS-7957: rows the outbox delete ACTUALLY removed, threaded
      // from `deleteMany`'s own `count` rather than inferred from the ack
      // length. Those two disagree in the case that matters — an ack naming ids
      // whose rows are already gone — and the ack length reported progress that
      // had not happened. OMITTED when nothing measured a count (a source with
      // no outbox delegate, a version-skewed db-host peer), because an omission
      // reads as "unmeasured" downstream while a `0` reads as "measured, cleared
      // nothing". Triage evidence on the alert. The cursor-stall detector reads
      // it only when the lane's cursor boundary also moved forward (ISS-10429);
      // the count-alone suppression PR #5915 removed stays removed.
      ...(durablyClearedRows === undefined ? {} : { durablyClearedRows }),
      ...resolveDeliveredFreshness(input, split, deps),
    });
  }
}

/** The sent ids partitioned by the server's echo (see the module contract). */
type AckSplit = { ackedIds: string[]; omittedIds: string[] };

/**
 * Partition the sent ids on the server echo. No echo — an older server, or a
 * batch that did not request one — means the legacy whole-batch contract, so
 * every sent id is acked and none is omitted.
 *
 * Deliberately NOT short-circuited on `hasMoreChunks` (codex-connector review,
 * PR #4862). A non-final chunk cannot ACK its session — that only happens on the
 * final chunk — but the echo still answers a different question the drain must
 * respect: did the server PERSIST this chunk? Blanket-acking a rejected
 * non-final chunk let the tail keep draining over a hole it already knew about.
 */
function splitAckedIds(input: AcceptedAckInput): AckSplit {
  if (!input.acceptedSessionIds) {
    return { ackedIds: input.ids, omittedIds: [] };
  }
  const accepted = new Set(input.acceptedSessionIds);
  return {
    ackedIds: input.ids.filter((id) => accepted.has(id)),
    omittedIds: input.ids.filter((id) => !accepted.has(id)),
  };
}

/**
 * The durable clear and the in-memory advance it gates. `advanced: false` means
 * NOTHING advanced — either a lifecycle change raced the await, or the clear
 * could not commit — and the caller must return without logging a sync.
 */
async function advanceOnDurableClear(
  input: AcceptedAckInput,
  split: AckSplit,
  deps: AcceptedAckDeps,
  spendBatchCost: BatchCostLedger
): Promise<{
  advanced: boolean;
  deadLetteredOmitted: boolean;
  /** ISS-7957: absent when the clear reported no measurement. */
  durablyClearedRows?: number;
}> {
  const { syncMode } = input;
  const { ackedIds, omittedIds } = split;
  const generationAtAck = deps.sourceStateGeneration();
  // ISS-7265 AC3: BEFORE the clear, deliberately. The server has already
  // confirmed these rows, so what is owed is settled fact by now, and the two
  // failure directions are not symmetric: a debt recorded for a delivery whose
  // clear then fails costs one redundant re-queue that the next intact delivery
  // settles, while a debt recorded AFTER a clear that committed is lost outright
  // if the process dies in between — and the outbox row it would have leaned on
  // is already gone. Over-record is cheap; under-record is the data loss this
  // ledger exists to stop.
  await recordTilingDebtForDelivery(input, split, deps);
  await settlePriorityUploadsForDelivery(input, split, deps);
  reportUnsendableComponentUsageForDelivery(input, split);
  const clear = await deps.clearOutboxDurably(ackedIds);
  if (
    deps.sourceStateGeneration() !== generationAtAck ||
    !deps.isStarted() ||
    // ISS-8116: the generation pair above is blind to a compute-target/account
    // switch, which moves the identity without bumping it. Without this third
    // reading a batch acked under A dequeued and advanced A's cursor while B was
    // live — the exact post-await hole the pre-`handleBatchAck` check could not
    // close, because both of the awaits above sit inside it.
    !deps.isCurrentSourceIdentity()
  ) {
    // stop()/identity change raced the clear await. The durable delete (if it
    // committed) is still correct — those rows WERE acked — but the in-memory
    // state now belongs to a different lifecycle; leave it to the
    // reset/re-hydration machinery.
    return { advanced: false, deadLetteredOmitted: false };
  }
  if (!clear.cleared) {
    deps.logError(
      `acked batch (${syncMode}, ${ackedIds.length} session(s)) could not durably clear its outbox rows; ` +
        "leaving rows queued for a deduped re-send and retrying the clear on the next ack"
    );
    deps.emitTelemetry({
      ...spendBatchCost(),
      outcome: DesktopSyncBatchOutcome.Failure,
      reason: SyncReason.AckClearFailed,
    });
    return { advanced: false, deadLetteredOmitted: false };
  }
  clearRowFailureState(deps.rowState, ackedIds);
  // ISS-9418: and the LANE-level give-up, on the same evidence and at the same
  // moment. Unconditional, unlike the per-row clears above: the stamp is one
  // fact about the lane, so it does not need an id to have held a clock, and
  // clearing an absent stamp is the no-op the writer's change-detection makes
  // free once hydration has told it what the column holds.
  deps.clearLaneGiveUp();
  deps.dequeue(syncMode, ackedIds);
  // FEA-1962: once this dequeue empties both queues the client is fully caught
  // up — persist the watermark. Sequenced AFTER the committed outbox clear
  // (goal stage 2), so a persisted caught-up cursor can never race ahead of the
  // durable ledger it summarizes.
  deps.persistCursorIfCaughtUp();
  let deadLetteredOmitted = false;
  if (omittedIds.length > 0) {
    // The acked rows' Success below carries this POST's cost, so the fold is the
    // terminal event for it ONLY when the echo confirmed nothing.
    deadLetteredOmitted = foldOmittedRows(
      input,
      omittedIds,
      deps,
      ackedIds.length > 0 ? NO_BATCH_COST : spendBatchCost()
    );
  }
  // Only GENUINE forward progress re-arms the once-per-idle-cycle dead-letter
  // revisit. Before the row-level echo an accepted ack necessarily acked the
  // whole batch, so `resetDeadLetterRevisitAfterDrainedAck`'s own "never after a
  // re-failed promotion" caveat held by construction. Stage 2 breaks that: an
  // ACCEPTED batch can now confirm nothing and dead-letter the very row the
  // idle promotion just re-drove, which is exactly a re-failed promotion — and
  // re-arming on it turns the bounded once-per-cycle revisit into a per-tick
  // re-send loop for a row the server never persists.
  if (ackedIds.length > 0 && !deadLetteredOmitted) {
    deps.resetDeadLetterRevisitAfterDrainedAck();
  }
  return {
    advanced: true,
    deadLetteredOmitted,
    // Preserve OMISSION across the hop: an absent measurement must not become a
    // reported zero, which downstream reads as "cleared nothing" (ISS-7401).
    ...(clear.deletedRowCount === undefined
      ? {}
      : { durablyClearedRows: clear.deletedRowCount }),
  };
}

/** Every per-row failure/budget map a VERIFIED ack resets (see `AcceptedAckRowState`). */
function clearRowFailureState(
  rowState: AcceptedAckRowState,
  ackedIds: readonly string[]
): void {
  for (const id of ackedIds) {
    rowState.timeoutCountById.delete(id);
    rowState.rateLimitedCountById.delete(id);
    rowState.unknownAckReasonCountById.delete(id);
    rowState.ingestionFailedCountById.delete(id);
    rowState.laneStalledSinceMsById.delete(id);
    rowState.validationFailedCountById.delete(id);
    rowState.ackOmittedCountById.delete(id);
    rowState.validationBisectIds.delete(id);
    rowState.transportErrorCountById.delete(id);
    rowState.clearTransportTimeoutBudgetFor(id);
    rowState.nextRetryAfterMs.delete(id);
    rowState.deadLetterCountById.delete(id);
    rowState.chunkValidationCycleById.delete(id);
    rowState.ackOmittedCycleById.delete(id);
    rowState.deadLetteredIds.delete(id);
  }
}

/**
 * A NON-final chunk the server ACCEPTED but did not PERSIST (its id is absent
 * from the row-level echo — the server's `isForeignChunk` skip). The staged
 * sequence now has a hole that the rest of the tail can never fill: the server
 * advances `pendingChunkReceived` only for a contiguous in-sequence chunk, so
 * every later chunk arrives against a short count and the final one cannot
 * commit the revision.
 *
 * Draining on regardless is not merely wasted work, it is unsafe. `persisted:
 * false` is returned ONLY for a foreign chunk; a later in-sequence chunk landing
 * over the gap is not foreign, so it reports `persisted: true` and the echo would
 * ack it — clearing the outbox row for a session whose revision the server never
 * committed. So the tail is discarded here, exactly as the batch-failure and
 * capability-downgrade paths do, and the still-queued session re-prepares from
 * chunk 0 (re-staging the sequence and fully repairing it).
 *
 * The omission burns the same bounded `ack_omitted` budget as a final-chunk
 * omission, so this is self-limiting: the per-row backoff throttles the
 * re-prepare, and a sequence the server will never persist dead-letters rather
 * than re-chunking forever.
 */
function abandonUnpersistedChunkTail(
  input: AcceptedAckInput,
  split: AckSplit,
  deps: AcceptedAckDeps,
  spendBatchCost: BatchCostLedger
): void {
  deps.discardPendingChunkTail();
  deps.logError(
    `chunk for session ${split.omittedIds.join(", ")} (${input.syncMode}) was accepted but NOT persisted ` +
      `(absent from the row-level ack echo); discarding the remaining ${input.remainingChunks ?? 0} chunk(s) ` +
      "and leaving the session queued to re-prepare from chunk 0"
  );
  // This path returns before the Success gate, so the fold is unconditionally
  // the terminal event for the POST and carries its cost.
  foldOmittedRows(input, split.omittedIds, deps, spendBatchCost());
}

/**
 * Burn the bounded `ack_omitted` budget for rows the server accepted the batch
 * but did not confirm. The lane is provably healthy (their neighbors acked in
 * this same request), so the omission is row-attributable: defer with backoff
 * while budget remains, dead-letter once it is spent. Returns whether this fold
 * dead-lettered anything.
 *
 * That dead-letter is RECOVERABLE only while the row has re-drive cycles left,
 * mirroring ISS-5090. Recovery clears `ackOmittedCountById`, so an unconditional
 * `recoverable: true` would grant a permanently-omitted row a fresh
 * `MAX_CONSECUTIVE_ACK_OMITTED` cycle every window forever; the surviving
 * `ackOmittedCycleById` count makes the class terminal after
 * `MAX_ACK_OMITTED_DEAD_LETTERS`. The ids are partitioned rather than folded
 * under one flag because the budget is PER ROW — a batch can carry one id on its
 * first omission next to one that has already spent its allowance.
 */
function foldOmittedRows(
  input: AcceptedAckInput,
  omittedIds: string[],
  deps: AcceptedAckDeps,
  batchCost: BatchCost
): boolean {
  const deadLetteredBefore = deps.deadLetteredCount();
  const reDrivable: string[] = [];
  const terminal: string[] = [];
  for (const id of omittedIds) {
    const cycles = deps.rowState.ackOmittedCycleById.get(id) ?? 0;
    if (cycles < MAX_ACK_OMITTED_DEAD_LETTERS) {
      reDrivable.push(id);
    } else {
      terminal.push(id);
    }
  }
  for (const [ids, recoverable] of [
    [reDrivable, true],
    [terminal, false],
  ] as const) {
    if (ids.length === 0) {
      continue;
    }
    deps.applyBoundedFold({
      ids: [...ids],
      syncMode: input.syncMode,
      payloadBytes: input.payloadBytes,
      counter: deps.rowState.ackOmittedCountById,
      maxConsecutive: MAX_CONSECUTIVE_ACK_OMITTED,
      reason: SyncReason.AckOmitted,
      recoverable,
      backoffMs: ACK_OMITTED_BACKOFF_MS,
      recordOutboxOnDefer: true,
    });
  }
  const deadLetteredOmitted = deps.deadLetteredCount() > deadLetteredBefore;
  // One extra transport-health event for the omitted rows, mirroring the
  // unhydratable-drop pattern: it keeps the omissions visible to the FEA-3426
  // reason split. The omission itself is per-row, not a batch transport cost, so
  // `batchCost` is empty whenever a sibling event on this ack already reported
  // the POST — and carries it when this event is the ack's only one.
  deps.emitTelemetry({
    ...batchCost,
    outcome: deadLetteredOmitted
      ? DesktopSyncBatchOutcome.DeadLetter
      : DesktopSyncBatchOutcome.Failure,
    reason: SyncReason.AckOmitted,
  });
  if (deadLetteredOmitted) {
    deps.persistCursorIfCaughtUp();
  }
  return deadLetteredOmitted;
}

/**
 * The one-line sync log. Reports the count the server CONFIRMED, not the count
 * sent — on a partial echo the two differ, and "synced" must never overclaim. A
 * chunk drain reports its batch count as before (its session acks only on the
 * final chunk).
 */
function formatAckLine(
  input: AcceptedAckInput,
  split: AckSplit,
  deadLetteredOmitted: boolean,
  deps: AcceptedAckDeps
): string {
  const sizes = deps.queueSizes();
  const deadLettered = deps.deadLetteredCount();
  const deadLetterSuffix =
    deadLettered > 0 ? ` deadLettered=${deadLettered}` : "";
  const chunkSuffix = input.hasMoreChunks
    ? ` (chunk; ${input.remainingChunks} remaining)`
    : "";
  const syncedCount = input.hasMoreChunks
    ? input.sessionCount
    : split.ackedIds.length;
  const omittedDisposition = deadLetteredOmitted
    ? " (dead-lettered)"
    : " (deferred)";
  const omittedSuffix =
    split.omittedIds.length > 0
      ? ` ackOmitted=${split.omittedIds.length}${omittedDisposition}`
      : "";
  return `synced ${syncedCount} agent sessions (${input.syncMode})${chunkSuffix}; remaining incremental=${sizes.incremental} backfill=${sizes.backfill}${deadLetterSuffix}${omittedSuffix}`;
}

/**
 * The transport cost of one POST: the bytes it put on the wire and its
 * round-trip latency, as the telemetry event carries them. `latencyMs` is
 * OMITTED (never `null`/0) on a non-carrying event so an unmeasured round trip
 * cannot enter the latency distribution as a real sample.
 */
type BatchCost = { payloadBytes: number; latencyMs?: number };

/** The empty carry, for an event a sibling on the same ack already paid for. */
const NO_BATCH_COST: BatchCost = { payloadBytes: 0 };

/** Spend this ack's batch cost; every call after the first carries nothing. */
type BatchCostLedger = () => BatchCost;

/**
 * The batch cost, spendable EXACTLY ONCE per accepted ack.
 *
 * ISS-6202 gated the batch Success on a row-level ack, and on a zero-row echo
 * that left `foldOmittedRows`' `payloadBytes: 0` Failure as the ONLY event for a
 * POST that really did put bytes on the wire and really did take a round trip
 * (whitlockk review). The reporter these feed is a byte burn-down and a round-trip
 * timing, so dropping the cost makes a run of zero-row echoes look free —
 * hiding exactly the resend amplification the `ack_omitted` reason exists to
 * expose. Reporting it on BOTH events is the opposite error: double-counted
 * bytes, and one batch entering the latency distribution twice.
 *
 * So the cost rides whichever event is TERMINAL for the ack — Success when the
 * echo confirmed a row, the `ack_clear_failed` Failure when the durable clear
 * aborted processing, the `ack_omitted` fold when neither ran — and the ledger
 * makes a second carry structurally impossible rather than merely unintended.
 * The one path that deliberately spends nothing is a superseded lifecycle
 * (stop()/identity change racing the clear await), which emits no batch event at
 * all because the lane the POST belonged to no longer exists.
 */
function createBatchCostLedger(input: AcceptedAckInput): BatchCostLedger {
  let spent = false;
  return () => {
    if (spent) {
      return NO_BATCH_COST;
    }
    spent = true;
    return { payloadBytes: input.payloadBytes, latencyMs: input.latencyMs };
  };
}

/**
 * ISS-7496: the freshness attribute for THIS delivery, or nothing at all.
 *
 * Gated on a WHOLE batch's FINAL chunk. The measure names how stale the freshest
 * session the cloud now holds is, and neither a partial accept (the omitted rows
 * did not land) nor a non-final chunk (the session is not yet whole upstream)
 * can claim that — reporting the sent batch's maximum for either would overstate
 * cloud freshness, which is the exact failure this attribute exists to detect.
 * Absent keeps meaning unknown.
 */
function resolveDeliveredFreshness(
  input: AcceptedAckInput,
  split: AckSplit,
  deps: AcceptedAckDeps
): { freshestSessionLagMs?: number } {
  if (input.hasMoreChunks || split.omittedIds.length > 0) {
    return {};
  }
  const { lagMs, anomaly } = resolveFreshestSessionLagMs({
    freshestUpdatedAtMs: input.freshestUpdatedAtMs,
    confirmedAtMs: Date.now(),
  });
  if (anomaly) {
    deps.reportFreshnessAnomaly?.(anomaly);
  }
  return lagMs === null ? {} : { freshestSessionLagMs: lagMs };
}

/**
 * ISS-7265: the degradation attributes for THIS delivery, or nothing at all.
 *
 * The strip was measurable only on a FAILED attempt, and success is the path
 * that clears the durable outbox and dequeues the session — so the common case
 * of the data loss, the permanent one, emitted no telemetry whatsoever.
 *
 * Counted over the ids the server CONFIRMED rather than the ids that were sent,
 * and gated on the FINAL chunk, because both alternatives report a loss that
 * did not happen: an omitted row stays queued and will re-send its tiling, and
 * a non-final chunk has not dequeued anything yet. Gating on the final chunk
 * also stops one stripped session being counted once per chunk of its own
 * fallback split.
 *
 * `payloadShaping` rides along so a delivery states the same degraded shape a
 * failure states, instead of leaving a reader to infer it from a bare count.
 * Both are OMITTED when nothing was stripped — never `0`, never `whole` — since
 * a confident "this delivery was complete" on every ordinary batch is the
 * reassurance this ticket exists to remove.
 */
function resolveDeliveredStrip(
  input: AcceptedAckInput,
  split: AckSplit
): {
  payloadShaping?: SyncPayloadShaping;
  tilingStrippedSessionCount?: number;
} {
  if (input.hasMoreChunks) {
    return {};
  }
  const stripped = new Set(input.tilingStrippedSessionIds ?? []);
  const count = split.ackedIds.filter((id) => stripped.has(id)).length;
  if (count === 0) {
    return {};
  }
  return {
    payloadShaping: SyncPayloadShaping.TilingStripped,
    tilingStrippedSessionCount: count,
  };
}

/**
 * ISS-7265 AC3: turn this delivery into the durable tiling-debt ledger's two
 * facts — the sessions the cloud now holds WITHOUT a tiling it is owed, and the
 * sessions whose delivery settles an outstanding debt.
 *
 * Reached only from the final-chunk path, over the ids the server CONFIRMED, for
 * the same reasons {@link resolveDeliveredStrip} states: an omitted row stays
 * queued and re-sends its tiling, and a non-final chunk has dequeued nothing.
 * This is the site where the strip becomes PERMANENT — the outbox clear and the
 * dequeue follow immediately — so it is the only honest place to write down that
 * something is still owed.
 *
 * An `undefined` `tilingStrippedSessionIds` means this caller measured NOTHING,
 * which is not the same as "measured none". Recording a settle off it would
 * clear a real debt on the strength of a delivery that never reported, so the
 * whole ledger write is skipped instead.
 */
async function recordTilingDebtForDelivery(
  input: AcceptedAckInput,
  split: AckSplit,
  deps: AcceptedAckDeps
): Promise<void> {
  const stripped = input.tilingStrippedSessionIds;
  if (!(stripped && deps.recordTilingDebt)) {
    return;
  }
  const strippedSet = new Set(stripped);
  const owed: string[] = [];
  const settled: string[] = [];
  for (const id of split.ackedIds) {
    if (strippedSet.has(id)) {
      owed.push(id);
    } else {
      settled.push(id);
    }
  }
  if (owed.length > 0 || settled.length > 0) {
    await deps.recordTilingDebt({ owed, settled });
  }
}

/**
 * ISS-6999 (whitlockk, cid 3846110703; codex, cid 3846063729): report the
 * component-usage rows THIS delivery permanently left behind.
 *
 * The report lives here, and not at prepare or fold time, because only this
 * frame knows the rows are actually gone. A payload folded into a batch has
 * still to survive an empty-batch return, a stale-source return, a capability
 * downgrade, and a `sendBatch` that can throw — and every one of those leaves
 * the session queued for a re-prepare that measures the identical rows again.
 *
 * Gated for the same two reasons {@link recordTilingDebtForDelivery} is, which
 * together make the report exactly-once per session that really lost the rows.
 * On the FINAL chunk — not re-checked here, because the only caller,
 * {@link advanceOnDurableClear}, already runs solely on the `!hasMoreChunks`
 * path; a non-final chunk has dequeued nothing and can still have its whole tail
 * discarded, which re-prepares the session and measures the rows again. And over
 * the ids the SERVER confirmed, which IS checked here, because an omitted row
 * stays queued and re-sends.
 */
function reportUnsendableComponentUsageForDelivery(
  input: AcceptedAckInput,
  split: AckSplit
): void {
  if (split.ackedIds.length === 0) {
    return;
  }
  reportUnsendableComponentUsage(input.unsendableComponentUnits);
}

/**
 * ISS-10332: the server confirmed these sessions, so the cloud has now seen the
 * priorities they carried and a later web set or clear must win over them.
 *
 * Over the CONFIRMED ids only, and on the final chunk only (the sole caller runs
 * on that path): an omitted row stays queued and must carry its value again.
 * Before the outbox clear, because the echo is the confirmation: a clear that
 * then fails re-sends the session without a value it already delivered.
 */
async function settlePriorityUploadsForDelivery(
  input: AcceptedAckInput,
  split: AckSplit,
  deps: AcceptedAckDeps
): Promise<void> {
  if (!(input.priorityUploadClaims && deps.settlePriorityUploads)) {
    return;
  }
  const acked = new Set(split.ackedIds);
  const claims = input.priorityUploadClaims.filter((claim) =>
    acked.has(claim.sessionId)
  );
  if (claims.length > 0) {
    await deps.settlePriorityUploads(claims);
  }
}
