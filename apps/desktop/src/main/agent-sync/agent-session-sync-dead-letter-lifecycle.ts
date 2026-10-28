/**
 * @file agent-session-sync-dead-letter-lifecycle.ts
 * @description The dead-letter LIFECYCLE for the session sync lane — set aside,
 * bound, recover, promote, re-arm — extracted from the grandfathered
 * (shrink-only) `agent-session-sync-service.ts` in the same collaborator style
 * as `agent-session-sync-dispositions.ts` and `agent-session-sync-pass-pump.ts`.
 *
 * The five functions here are one mechanism, not five: an id enters via
 * `markDeadLettered` and leaves by one of THREE doors —
 *
 * - `recoverExpiredDeadLetters` for TRANSIENT classes (ack timeout,
 *   rate_limited, ingestion_failed), which carry a FINITE FEA-3363 retry-after
 *   and come back on their own progressive-backoff schedule;
 * - `promoteDeadLetterIfIdle` for PERMANENTLY-STUCK classes, which carry an
 *   INFINITE deadline and are revisited at most once per idle cycle, only after
 *   both queues have drained; and
 * - `enforceDeadLetterCap`, which bounds the set and is NOT selective by class:
 *   it evicts the oldest ids regardless of deadline.
 *
 * The first two are disjoint BY DEADLINE, which is what stops them fighting over
 * the same id, and that invariant is only legible with the two side by side.
 *
 * ISS-7216: the cap was long described as merely "bounding" the set rather than
 * as a door, and that framing is what hid a data-loss bug — it is the only exit
 * that can remove an id the other two never got to, so it owes the same durable
 * `recordOutboxReEnqueue` they perform. All three now hand the row back to the
 * pending outbox before releasing it; see `enforceDeadLetterCap`.
 *
 * `resetDeadLetterRevisitAfterDrainedAck` is not a door — it is
 * `promoteDeadLetterIfIdle`'s re-arm, clearing the once-per-idle-cycle guard
 * after a promoted dead-letter actually drains.
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
    attemptCount: number,
    permanentAttemptCount: number | null,
    deadLetterRecoveryCount: number | null
  ) => void;
  /**
   * The durable `dead_lettered` → `pending` flip every door performs on its way
   * out. ISS-7216: it REPORTS whether the row is confirmed off `dead_lettered`
   * (`false` when the write threw or left it there; it never rejects). The two
   * recovery doors ignore that — they keep the id in `deadLetteredIds` either
   * way — and `enforceDeadLetterCap` gates its release on it, because for the
   * cap the durable row is the only record left.
   */
  recordOutboxReEnqueue: (id: string) => Promise<boolean>;
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
  permanentAttemptCount: number | null,
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
  deps.recordOutboxDeadLetter(
    id,
    reason,
    attemptCount,
    permanentAttemptCount,
    recoverable ? deadLetterCount : null
  );
}

/**
 * Keep both the in-memory `deadLetteredIds` Map and — because
 * `persistCursorIfCaughtUp` serializes its keys — the persisted
 * `dead_lettered_ids` JSON bounded at `MAX_DEAD_LETTERED_IDS`. Evicts the
 * OLDEST entries first (Map iteration is insertion order): a re-set id keeps
 * its original insertion position, so eviction targets the sessions
 * dead-lettered longest ago.
 *
 * ISS-7216: eviction must HAND THE ROW BACK to the durable pending ledger, not
 * merely forget it. This is the third door out of `deadLetteredIds`, and it was
 * the only one that skipped `recordOutboxReEnqueue` — which is exactly the
 * FEA-3697 durability step the other two perform for the reason stated at both
 * of their call sites: a row left `dead_lettered` is invisible to
 * `loadPendingOutboxIds`, to stranded-row adoption, and to the incremental scan
 * (the watermark is already past it), so the in-memory Map is the ONLY thing
 * that still remembers the session is owed. Dropping the id therefore closed
 * every re-entry door at once.
 *
 * The docblock here used to claim that was harmless because "a future
 * cold-restart re-backfill re-walks it if it still exists locally". It does not:
 * `initializeBackfillQueueIfNeeded` early-returns the moment a cursor is
 * resumed, so a device past its first backfill never re-walks the corpus. The
 * evicted row sat in SQLite as `dead_lettered` forever — never sent, and never
 * even purged, because `selectUndeliveredSessionIds` matches any status. Only a
 * version-stamp bump (`sqliteRependDeadLetteredForFormulaRewalk`) or new local
 * activity on that session could rescue it, and an ENDED session never gets
 * new activity — which is precisely the population backfill exists to deliver.
 *
 * Re-pending is what satisfies `main/sync/AGENTS.md` invariant 10 — "Eviction
 * must degrade to 're-discovered later', never to 'lost'." The cap bounds
 * MEMORY; the durable outbox row owns DURABILITY. The verified-ack delete stays
 * the only clear, so exactly-once still holds — a re-send of an already-applied
 * payload is server-deduped.
 *
 * ISS-7216 (PR #5708 review, whitlockk): the hand-off is CONFIRMED, not merely
 * attempted, and the two are not the same thing here. The sibling doors can
 * re-pend fire-and-forget because they re-queue the id onto a live lane and it
 * stays in `deadLetteredIds` either way, so a swallowed write failure costs only
 * a hint. This door removes the id — that is its whole job — so a swallowed
 * failure costs the SESSION. Both failure modes matter and only one of them
 * throws: a rejected write (locked or closing DB, a db-host IPC fault), and a
 * write that MATCHES ZERO ROWS while the row is still `dead_lettered`, which
 * "succeeds" without touching anything and is indistinguishable from a real
 * hand-off unless someone asks. So the id is released ONLY after
 * `recordOutboxReEnqueue` resolves `true` — and that `true` is the source
 * reading the row back, not the absence of a throw. On `false` the id stays in
 * the Map with its deadline and escalation counters intact, and the next cap
 * pass retries it.
 *
 * The cost of that ordering is that the bound is reached ASYNCHRONOUSLY: between
 * the request and its confirmation the Map sits over the cap by the number of
 * in-flight hand-offs, which is itself bounded by the overflow, and a persist in
 * that window serializes a correspondingly longer array. Memory yields to
 * durability, which is the order invariant 10 puts them in. In-flight ids are
 * skipped by later passes (`evictionHandoffsInFlight`) so a stalled ledger
 * cannot make the same id accumulate duplicate writes.
 */
export function enforceDeadLetterCap(deps: DeadLetterLifecycleDeps): void {
  if (deps.deadLetteredIds.size <= MAX_DEAD_LETTERED_IDS) {
    return;
  }
  const inFlight = evictionHandoffsInFlight(deps);
  // Ids already being handed off still count against the overflow — they are
  // leaving, just not yet confirmed — so only the remainder starts a new write.
  const starting =
    deps.deadLetteredIds.size - MAX_DEAD_LETTERED_IDS - inFlight.size;
  if (starting <= 0) {
    return;
  }
  const evicting: string[] = [];
  for (const oldest of deps.deadLetteredIds.keys()) {
    if (evicting.length >= starting) {
      break;
    }
    if (!inFlight.has(oldest)) {
      evicting.push(oldest);
    }
  }
  if (evicting.length === 0) {
    return;
  }
  for (const id of evicting) {
    inFlight.add(id);
  }
  logEvictionRequested(evicting, deps);
  Promise.all(evicting.map((id) => releaseEvictedId(id, inFlight, deps)))
    .then((released) => {
      const stranded = released.filter((ok) => !ok).length;
      if (stranded > 0) {
        deps.logWarn(
          `${stranded} of ${evicting.length} evicted dead-lettered agent session(s) could not be ` +
            "handed back to the durable pending outbox; they stay in the in-memory dead-letter " +
            "set (nothing dropped) and the next cap pass retries the hand-off"
        );
      }
    })
    .catch(() => {
      // `releaseEvictedId` folds every failure into `false` and never rejects;
      // this only exists because a floating promise is a lint error.
    });
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
    ignoreReEnqueueConfirmation(id, deps);
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
  ignoreReEnqueueConfirmation(id, deps);
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

/**
 * ISS-7216: how many evicted ids `enforceDeadLetterCap` names in its log line
 * before truncating to a count. Enough to identify the affected sessions when a
 * handful are evicted on a live tick, bounded so the legacy-cursor hydration
 * path — which can evict thousands in one pass — cannot emit a multi-megabyte
 * gateway log entry. The COUNT is always exact; only the id sample is capped.
 */
const EVICTION_LOG_ID_SAMPLE = 20;

/**
 * ISS-7216: the ids whose durable eviction hand-off has been requested but not
 * yet confirmed, per lane.
 *
 * Keyed on the lane's own `deadLetteredIds` Map — the collection it guards, and
 * the one piece of lifecycle state that is already passed by reference and lives
 * exactly as long as the lane. That keeps this derived bookkeeping out of both
 * the deps contract and the (grandfathered) sync service, and a `WeakMap` means
 * a disposed lane's entry goes with it rather than accumulating; `deps` itself
 * is rebuilt per call and so cannot be the key.
 */
const EVICTION_HANDOFFS_IN_FLIGHT = new WeakMap<
  Map<string, number>,
  Set<string>
>();

function evictionHandoffsInFlight(deps: DeadLetterLifecycleDeps): Set<string> {
  const existing = EVICTION_HANDOFFS_IN_FLIGHT.get(deps.deadLetteredIds);
  if (existing) {
    return existing;
  }
  const created = new Set<string>();
  EVICTION_HANDOFFS_IN_FLIGHT.set(deps.deadLetteredIds, created);
  return created;
}

/**
 * ISS-7216: request the durable hand-off for one evicted id and release the
 * in-memory reference ONLY if it is confirmed. Resolves whether the id left.
 *
 * On `false` nothing is mutated: the entry keeps its retry-after deadline and
 * its FEA-3795 escalation position, so a retried eviction neither restarts the
 * progressive backoff nor loses the session. The counters are dropped with the
 * id (never before it) so they stay bounded by the same cap.
 */
async function releaseEvictedId(
  id: string,
  inFlight: Set<string>,
  deps: DeadLetterLifecycleDeps
): Promise<boolean> {
  let handedOff = false;
  try {
    handedOff = await deps.recordOutboxReEnqueue(id);
  } catch {
    handedOff = false;
  } finally {
    inFlight.delete(id);
  }
  if (!handedOff) {
    return false;
  }
  deps.deadLetteredIds.delete(id);
  // FEA-3795: drop the escalation counter for the evicted id too, so
  // `deadLetterCountById` stays bounded by the same cap (an evicted id is
  // forgotten; if it re-dead-letters later it starts a fresh escalation).
  deps.deadLetterCountById.delete(id);
  deps.chunkValidationCycleById.delete(id);
  deps.ackOmittedCycleById.delete(id);
  return true;
}

/**
 * ISS-7216: the two RECOVERY doors deliberately discard the re-pend's
 * confirmation. They keep the id in `deadLetteredIds` and re-queue it onto a
 * live lane, so a failed write costs only this process's durable hint and the
 * next persist still records the id — the fallback the cap does not have. The
 * write never rejects (the writer folds failures into `false` and warn-logs
 * them); the attached handler exists because a floating promise is a lint error
 * and `noVoid` is enforced for this module.
 */
function ignoreReEnqueueConfirmation(
  id: string,
  deps: DeadLetterLifecycleDeps
): void {
  deps.recordOutboxReEnqueue(id).catch(() => {
    // Unreachable: see above.
  });
}

/**
 * The eviction's summary log. States what was REQUESTED, not what landed: the
 * hand-offs are still in flight here, and each id is dropped from the in-memory
 * set only once its own write is confirmed (a failed batch warns separately).
 *
 * The id list is TRUNCATED, unlike the sibling doors' logs: those evict a
 * handful, but the hydration call site caps a legacy over-cap cursor in one pass
 * and can evict thousands at once.
 */
function logEvictionRequested(
  evicting: string[],
  deps: DeadLetterLifecycleDeps
): void {
  const shown = evicting.slice(0, EVICTION_LOG_ID_SAMPLE);
  const omitted = evicting.length - shown.length;
  deps.logWarn(
    `dead-letter set exceeded ${MAX_DEAD_LETTERED_IDS}; requested a durable re-pend for the ` +
      `${evicting.length} oldest dead-lettered agent session(s), each of which leaves the ` +
      `in-memory set only once its re-pend is confirmed; ids: ${shown.join(", ")}` +
      `${omitted > 0 ? ` (+${omitted} more)` : ""}`
  );
}
