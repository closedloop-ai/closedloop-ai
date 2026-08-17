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
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../telemetry/app-otel-runtime.js";
import type { BoundedFailureFoldConfig } from "./agent-session-sync-ack-fold.js";
import {
  ACK_OMITTED_BACKOFF_MS,
  MAX_ACK_OMITTED_DEAD_LETTERS,
  MAX_CONSECUTIVE_ACK_OMITTED,
} from "./agent-session-sync-backoff-policy.js";

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
};

/**
 * The per-row failure/budget state a VERIFIED ack resets. Passed as the live
 * maps (the fold-module precedent) so the reset semantics live here with the
 * processing order, not as a dozen callbacks.
 */
export type AcceptedAckRowState = {
  timeoutCountById: Map<string, number>;
  /**
   * FEA-1461: a successful ack resets the rate-limit counter and clears any
   * deferred-retry deadline, so a future rejection starts over at 1.
   */
  rateLimitedCountById: Map<string, number>;
  ingestionFailedCountById: Map<string, number>;
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
  /** The awaited, success-reporting durable clear (`clearOutboxOnAck`). */
  clearOutboxDurably: (ids: string[]) => Promise<boolean>;
  /** Superseded-lifecycle guard values, re-read AFTER the clear await. */
  sourceStateGeneration: () => number;
  isStarted: () => boolean;
  dequeue: (syncMode: AgentSessionSyncMode, ids: string[]) => void;
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
  emitTelemetry: (event: DesktopSyncBatchEventInput) => void;
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
  if (!hasMoreChunks) {
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
): Promise<{ advanced: boolean; deadLetteredOmitted: boolean }> {
  const { syncMode } = input;
  const { ackedIds, omittedIds } = split;
  const generationAtAck = deps.sourceStateGeneration();
  const cleared = await deps.clearOutboxDurably(ackedIds);
  if (deps.sourceStateGeneration() !== generationAtAck || !deps.isStarted()) {
    // stop()/identity change raced the clear await. The durable delete (if it
    // committed) is still correct — those rows WERE acked — but the in-memory
    // state now belongs to a different lifecycle; leave it to the
    // reset/re-hydration machinery.
    return { advanced: false, deadLetteredOmitted: false };
  }
  if (!cleared) {
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
  return { advanced: true, deadLetteredOmitted };
}

/** Every per-row failure/budget map a VERIFIED ack resets (see `AcceptedAckRowState`). */
function clearRowFailureState(
  rowState: AcceptedAckRowState,
  ackedIds: readonly string[]
): void {
  for (const id of ackedIds) {
    rowState.timeoutCountById.delete(id);
    rowState.rateLimitedCountById.delete(id);
    rowState.ingestionFailedCountById.delete(id);
    rowState.validationFailedCountById.delete(id);
    rowState.ackOmittedCountById.delete(id);
    rowState.validationBisectIds.delete(id);
    rowState.transportErrorCountById.delete(id);
    rowState.clearTransportTimeoutBudgetFor(id);
    rowState.nextRetryAfterMs.delete(id);
    rowState.deadLetterCountById.delete(id);
    rowState.chunkValidationCycleById.delete(id);
    rowState.ackOmittedCycleById.delete(id);
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
 * (wongk review). The reporter these feed is a byte burn-down and a round-trip
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
