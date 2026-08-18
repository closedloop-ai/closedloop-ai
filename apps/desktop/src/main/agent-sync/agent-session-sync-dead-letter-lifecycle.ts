/**
 * @file agent-session-sync-dead-letter-lifecycle.ts
 * @description The dead-letter LIFECYCLE for the session sync lane — set aside,
 * bound, recover, promote, re-arm — extracted from the grandfathered
 * (shrink-only) `agent-session-sync-service.ts` in the same collaborator style
 * as `agent-session-sync-dispositions.ts` and `agent-session-sync-pass-pump.ts`.
 *
 * The five functions here are one mechanism, not five: an id enters via
 * `markDeadLettered`, the set is bounded by `enforceDeadLetterCap`, and it
 * leaves by exactly one of two disjoint doors —
 *
 * - `recoverExpiredDeadLetters` for TRANSIENT classes (ack timeout,
 *   rate_limited, ingestion_failed), which carry a FINITE FEA-3363 retry-after
 *   and come back on their own progressive-backoff schedule; and
 * - `promoteDeadLetterIfIdle` for PERMANENTLY-STUCK classes, which carry an
 *   INFINITE deadline and are revisited at most once per idle cycle, only after
 *   both queues have drained.
 *
 * They are disjoint BY DEADLINE, which is what stops them fighting over the
 * same id, and that invariant is only legible with the two side by side.
 * `resetDeadLetterRevisitAfterDrainedAck` is the third door's re-arm: it clears
 * the once-per-idle-cycle guard after a promoted dead-letter actually drains.
 *
 * Behavior-preserving extraction: every deadline rule, counter, log string, and
 * ordering decision is carried over verbatim from the service.
 */
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  deadLetterRetryDelayMs,
  MAX_DEAD_LETTERED_IDS,
} from "./agent-session-sync-backoff-policy.js";
import { CHUNK_VALIDATION_FAILED_REASON } from "./agent-session-sync-validation-failure.js";

/**
 * The service-owned state and collaborators the dead-letter lifecycle needs.
 *
 * The collections are passed BY REFERENCE (same discipline as
 * {@link import("./backfill-queue-feed.js").BackfillQueueFeedState}) so this
 * module mutates the service's own queues and maps rather than a copy. The
 * scalars the service reassigns — the pending-chunk slot, the backfill toggle,
 * the idle-cycle guard — are threaded as accessors, since a snapshot of a
 * primitive would go stale between passes.
 */
export type DeadLetterLifecycleDeps = {
  /** id → wall-clock ms after which live recovery may re-enqueue it. */
  deadLetteredIds: Map<string, number>;
  /** FEA-3795 progressive-backoff escalation position, per id. */
  deadLetterCountById: Map<string, number>;
  /** ISS-5090 chunk-validation allowance, charged on its own class only. */
  chunkValidationCycleById: Map<string, number>;
  /** Goal stage 2: the ack-omitted allowance, same per-class charging. */
  ackOmittedCycleById: Map<string, number>;
  backfillQueue: string[];
  backfillQueuedIds: Set<string>;
  incrementalQueue: string[];
  incrementalQueuedIds: Set<string>;
  hasPendingChunks: () => boolean;
  isHistoricalBackfillEnabled: () => boolean;
  wasDeadLetterRevisitedThisIdleCycle: () => boolean;
  setDeadLetterRevisitedThisIdleCycle: (revisited: boolean) => void;
  clearFailureStateForId: (id: string) => void;
  recordOutboxDeadLetter: (
    id: string,
    reason: string,
    attemptCount: number
  ) => void;
  recordOutboxReEnqueue: (id: string) => void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
};

/**
 * FEA-3363: record a dead-lettered id together with the wall-clock deadline
 * after which `recoverExpiredDeadLetters` may re-enqueue it. Every dead-letter
 * site funnels through here so the retry-after stamp can never be forgotten.
 *
 * `recoverable` gates LIVE (no-restart) recovery by failure class. Only
 * TRANSIENT rejections — ack timeout, rate_limited, ingestion_failed — get a
 * finite retry-after, because the underlying throttle/backpressure genuinely
 * clears with time (this is the FEA-3363 case: the observed 52 strands were
 * rate-limited). DETERMINISTIC failures — a locally-oversized payload (a
 * client-side byte cap it can never fit) and validation_failed (a schema
 * rejection the relay repeated across the whole FEA-3366 retry budget for the
 * identical payload) — get an infinite deadline so live recovery never
 * re-enqueues them: doing so would just
 * re-detect/re-reject and re-dead-letter on a pointless 24h cycle, spamming the
 * relay and telemetry. Those classes keep their prior behavior exactly —
 * terminal within the process, retried only by a cold-restart re-backfill
 * (where a client cap bump or a relay schema fix may since have rolled out).
 * They still count toward `deadLetteredIds.size`, so the persist block and the
 * PRD-482 dashboard are unchanged.
 */
export function markDeadLettered(
  id: string,
  recoverable: boolean,
  reason: string,
  attemptCount: number,
  deps: DeadLetterLifecycleDeps
): void {
  // FEA-3795 (PRD-536 E2): progressive backoff. Bump the per-id dead-letter
  // count and derive the retry window from it, so the first transient
  // dead-letter recovers fast (short base window) and each re-dead-letter of
  // the same id doubles the window toward the 24h cap. The count survives
  // recovery (only a verified ack clears it) so a persistently-failing id
  // escalates instead of resetting to the short window every cycle.
  //
  // Deterministic (non-recoverable) classes keep the infinite set-aside
  // deadline and do not participate in the escalation — they are terminal
  // within the process and retried only by a cold-restart re-backfill, so a
  // growing finite window would be meaningless for them.
  let deadLetterCount = 0;
  if (recoverable) {
    deadLetterCount = (deps.deadLetterCountById.get(id) ?? 0) + 1;
    deps.deadLetterCountById.set(id, deadLetterCount);
    // ISS-5090: charge the chunk-validation allowance ONLY on its own class.
    if (reason === CHUNK_VALIDATION_FAILED_REASON) {
      const cycles = (deps.chunkValidationCycleById.get(id) ?? 0) + 1;
      deps.chunkValidationCycleById.set(id, cycles);
    }
    // Goal stage 2: same per-class charging for the ack-omitted allowance.
    if (reason === SyncReason.AckOmitted) {
      const cycles = (deps.ackOmittedCycleById.get(id) ?? 0) + 1;
      deps.ackOmittedCycleById.set(id, cycles);
    }
  }
  deps.deadLetteredIds.set(
    id,
    recoverable
      ? Date.now() + deadLetterRetryDelayMs(deadLetterCount)
      : Number.POSITIVE_INFINITY
  );
  enforceDeadLetterCap(deps);
  // FEA-3473: durably record the abandonment in the outbox with the reason, so
  // a stuck item is never silently dropped and can never block persistence.
  // FEA-3659: carry the exhausted transient retry count so the outbox reflects
  // the real number of attempts a transient failure burned before
  // dead-lettering. (FEA-3795 keeps this semantics intact — the progressive
  // escalation position lives in the in-memory `deadLetterCountById`; the
  // outbox `attempt_count` continues to mean "burned transient budget".)
  deps.recordOutboxDeadLetter(id, reason, attemptCount);
}

/**
 * Keep both the in-memory `deadLetteredIds` Map and — because
 * `persistCursorIfCaughtUp` serializes its keys — the persisted
 * `dead_lettered_ids` JSON bounded at `MAX_DEAD_LETTERED_IDS`. Evicts the
 * OLDEST entries first (Map iteration is insertion order): a re-set id keeps
 * its original insertion position, so eviction targets the sessions
 * dead-lettered longest ago. Dropping an id only forgets that it was set
 * aside; the watermark already advanced past it, so nothing un-uploaded is
 * skipped, and a future cold-restart re-backfill re-walks it if it still
 * exists locally.
 */
export function enforceDeadLetterCap(deps: DeadLetterLifecycleDeps): void {
  if (deps.deadLetteredIds.size <= MAX_DEAD_LETTERED_IDS) {
    return;
  }
  const overflow = deps.deadLetteredIds.size - MAX_DEAD_LETTERED_IDS;
  const iterator = deps.deadLetteredIds.keys();
  for (let i = 0; i < overflow; i++) {
    const oldest = iterator.next().value;
    if (oldest === undefined) {
      break;
    }
    deps.deadLetteredIds.delete(oldest);
    // FEA-3795: drop the escalation counter for the evicted id too, so
    // `deadLetterCountById` stays bounded by the same cap (an evicted id is
    // forgotten; if it re-dead-letters later it starts a fresh escalation).
    deps.deadLetterCountById.delete(oldest);
    deps.chunkValidationCycleById.delete(oldest);
    deps.ackOmittedCycleById.delete(oldest);
  }
}

/**
 * FEA-3363: re-enqueue any dead-lettered session whose retry-after deadline has
 * elapsed. Without this a dead-letter is only ever retried on a cold-restart
 * re-backfill — and because a non-empty dead-letter set also blocks cursor
 * persistence, a desktop that simply keeps running strands those sessions
 * forever (observed: deadLettered=52 never reached the cloud). Re-enqueueing on
 * expiry with a reset failure counter restores the eventual-consistency
 * guarantee: every locally-captured session keeps a live path to the cloud.
 *
 * Recovered ids go onto the backfill queue (the bounded catch-up lane). Their
 * failure counters were cleared at dead-letter time; clearing again here is
 * defensive so the recovered session starts its per-class retry budget over at
 * zero.
 *
 * FEA-3795: the PROGRESSIVE-backoff escalation counter (`deadLetterCountById`)
 * is deliberately NOT reset here — a session that recovers and then re-fails
 * must escalate to a longer window, not restart at the short base. Only a
 * verified server ack (real forward progress) clears it.
 */
export function recoverExpiredDeadLetters(
  nowMs: number,
  deps: DeadLetterLifecycleDeps
): void {
  const recovered: string[] = [];
  for (const [id, retryAfterMs] of deps.deadLetteredIds) {
    if (retryAfterMs > nowMs) {
      continue;
    }
    deps.deadLetteredIds.delete(id);
    deps.clearFailureStateForId(id);
    // FEA-3697: the in-memory re-enqueue below is not enough — the durable
    // outbox row is still `dead_lettered`, so a restart before this recovered
    // session re-syncs would let `loadPendingOutboxIds` skip it and strand it.
    // Durably flip the row back to `pending` (reset budget) so recovery
    // survives a crash/restart and the row follows the bounded retry policy
    // again. The verified-ack delete stays the only clear, so exactly-once
    // holds (a re-send of an already-applied payload is server-deduped).
    deps.recordOutboxReEnqueue(id);
    // A dead-letter dequeued the id from both lanes, so it should not already
    // be queued; guard against a duplicate push regardless.
    reEnqueueOntoBackfill(id, deps);
    recovered.push(id);
  }
  if (recovered.length > 0) {
    deps.logWarn(
      `re-enqueued ${recovered.length} dead-lettered agent session(s) whose ` +
        `progressive retry window elapsed; ids: ${recovered.join(", ")}; ` +
        `remaining deadLettered=${deps.deadLetteredIds.size}`
    );
  }
}

/**
 * Lowest-priority dead-letter revisit. Dead-lettered sessions are set aside and
 * de-prioritized: they are revisited ONLY after the ENTIRE rest of backfill is
 * complete — i.e. after BOTH the incremental AND backfill queues are drained to
 * empty — and then only ONCE per idle cycle. This is what lets a session that
 * was intentionally abandoned this run (or seeded set-aside on resume) reach the
 * cloud without an eager retry storm and without ever preempting genuinely-new
 * live/backfill work.
 *
 * Scope: this revisit only touches PERMANENTLY-STUCK dead-letters — those with
 * an INFINITE retry-after deadline (deterministic classes: locally oversize,
 * validation_failed, or a resume-seeded set-aside id). TRANSIENT dead-letters
 * (ack timeout / rate_limited / ingestion_failed) carry a finite FEA-3363
 * retry-after and are recovered on their own schedule by
 * `recoverExpiredDeadLetters`; promoting them early here would defeat that
 * backoff. The two mechanisms are disjoint by deadline, so they never fight.
 *
 * Hot-loop guard: `deadLetterRevisitedThisIdleCycle` marks the promotion already
 * done for this idle cycle, so a promoted dead-letter that re-fails re-enters
 * `deadLetteredIds` but is NOT immediately re-promoted — it waits for the next
 * idle cycle, which only begins after genuinely-new incremental/backfill work is
 * enqueued (that enqueue resets the flag). Net ordering: live > backfill > (only
 * when both empty, once per idle cycle) dead-letter retry.
 *
 * Promotes a SINGLE dead-letter (FIFO by insertion order) onto the backfill
 * queue — the bounded catch-up lane — so a large set of stranded rows is drained
 * one-per-idle-cycle rather than flooded back all at once.
 */
export function promoteDeadLetterIfIdle(deps: DeadLetterLifecycleDeps): void {
  if (
    !deps.isHistoricalBackfillEnabled() ||
    deps.wasDeadLetterRevisitedThisIdleCycle() ||
    deps.incrementalQueue.length > 0 ||
    deps.backfillQueue.length > 0 ||
    deps.hasPendingChunks() ||
    deps.deadLetteredIds.size === 0
  ) {
    return;
  }
  // Both queues are empty and we have not yet revisited this idle cycle. Find
  // the first PERMANENTLY-STUCK (infinite-deadline) dead-letter; transient
  // finite-deadline entries are left to recoverExpiredDeadLetters.
  const id = firstPermanentlyStuckId(deps);
  if (id === null) {
    return;
  }
  // Mark the revisit done (so it cannot re-fire until new real work resets the
  // flag) and promote exactly one set-aside dead-letter back onto the backfill
  // lane.
  deps.setDeadLetterRevisitedThisIdleCycle(true);
  deps.deadLetteredIds.delete(id);
  deps.clearFailureStateForId(id);
  // FEA-3697: same durability concern as recoverExpiredDeadLetters — a promoted
  // set-aside straggler is re-queued for send, so its durable outbox row must
  // flip from `dead_lettered` back to `pending`. Otherwise a restart before it
  // re-syncs would drop it from `loadPendingOutboxIds` and it would only ever
  // return via the cursor's `deadLetteredIds` set-aside (never as live pending
  // work), risking a permanent strand if that set was also lost.
  deps.recordOutboxReEnqueue(id);
  reEnqueueOntoBackfill(id, deps);
  deps.logInfo(
    "revisiting 1 set-aside dead-lettered agent session after backfill drained; " +
      `id: ${id}; remaining deadLettered=${deps.deadLetteredIds.size}`
  );
}

/**
 * A promoted set-aside dead-letter that drained successfully is genuine
 * forward progress: reset the idle-cycle guard so the NEXT persisted
 * dead-letter can be promoted on a subsequent idle tick — without this only a
 * single dead-letter is ever revisited per process (until unrelated new work
 * resets the flag). Gated on both queues being empty and dead-letters
 * remaining, so it fires only after a successful drain — never after a
 * re-failed promotion — preserving the hot-loop guard. Called by the
 * accepted-ack processor (`agent-session-sync-accepted-ack.ts`).
 */
export function resetDeadLetterRevisitAfterDrainedAck(
  deps: DeadLetterLifecycleDeps
): void {
  if (
    deps.wasDeadLetterRevisitedThisIdleCycle() &&
    deps.deadLetteredIds.size > 0 &&
    deps.incrementalQueue.length === 0 &&
    deps.backfillQueue.length === 0 &&
    !deps.hasPendingChunks()
  ) {
    deps.setDeadLetterRevisitedThisIdleCycle(false);
  }
}

/** The first INFINITE-deadline (permanently stuck) id, FIFO by insertion. */
function firstPermanentlyStuckId(deps: DeadLetterLifecycleDeps): string | null {
  for (const [candidateId, retryAfterMs] of deps.deadLetteredIds) {
    if (retryAfterMs === Number.POSITIVE_INFINITY) {
      return candidateId;
    }
  }
  return null;
}

/**
 * Push a recovered/promoted id back onto the bounded catch-up lane. A
 * dead-letter dequeued the id from both lanes, so it should not already be
 * queued; the guard is defensive against a duplicate push regardless.
 */
function reEnqueueOntoBackfill(
  id: string,
  deps: DeadLetterLifecycleDeps
): void {
  if (deps.backfillQueuedIds.has(id) || deps.incrementalQueuedIds.has(id)) {
    return;
  }
  deps.backfillQueuedIds.add(id);
  deps.backfillQueue.push(id);
}
