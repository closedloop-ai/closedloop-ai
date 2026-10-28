/**
 * @file agent-component-sync-dead-letter.ts
 * @description Dead-letter machinery for the component-inventory sync lane
 * (`runComponentSync` in {@link AgentSessionSyncService}), ISS-4542. Houses the
 * `ComponentSyncDeadLetterTracker` plus the lane's send-failure decision
 * (`handleComponentSendFailure`), the drained re-attempt (`recoverComponentDeadLetters`),
 * and the keyset cursor advance (`advanceComponentCursor`) — extracted from the
 * grandfathered sync service so the new resilience behavior lives in its own module.
 *
 * PROBLEM (before this module): the component lane sent a keyset-ordered batch
 * via `sendComponents` and, on ANY non-2xx (including a permanent 403), left the
 * durable cursor UNMOVED so the SAME batch retried on the next 5s tick. For a
 * PERMANENT failure — a 403 that never clears, schema drift, a poison row — this
 * HEAD-OF-LINE-BLOCKED the whole lane forever: nothing behind the bad batch ever
 * synced and it re-failed every tick.
 *
 * FIX (this module + the `runComponentSync` wiring): a failing batch is retried
 * a BOUNDED number of times at its keyset boundary, then DEAD-LETTERED to the
 * BACK of the line — the cursor advances past it so the lane drains everything
 * else. Dead-lettered component ids are re-attempted ONLY once the live cursor
 * is otherwise drained AND no newer incremental work has entered (so live data
 * is never starved by a poison backlog item), each re-attempt on a doubling
 * backoff, and after a bounded number of re-attempts the id is QUARANTINED
 * (parked, no longer auto-retried) instead of spinning forever. Nothing is ever
 * hard-dropped: the dead-letter ids are persisted onto the durable cursor row
 * (`PersistedSyncState.deadLetteredIds`) and re-seeded on hydration, so a cold
 * restart re-drives even a quarantined item rather than stranding it past the
 * advanced cursor; it also still re-syncs on the next natural change (its
 * `last_seen_at` advancing past the cursor).
 *
 * ISS-8593 closed the two remaining ways an item could still be lost for good.
 *
 * (1) The snapshot carried BARE IDS, so a restart re-seeded every entry at
 * attempt 0 due immediately — a row that had backed off to the 24h ceiling was
 * re-hammered on every launch, and a restart loop pinned it at the base window.
 * `PersistedSyncState.deadLetterAttempts` now carries each id's `attempts`,
 * `tombstoned` flag, and the deadline it was waiting on, and a re-seed resumes
 * that deadline CLAMPED to `[now, now + delay(attempts)]`. Both clamps are
 * load-bearing: the lower one makes time the app spent closed count, so a
 * short-lived process still re-drives rather than restarting the window on every
 * launch; the upper one bounds what a bogus stored instant can cost. Quarantine
 * is not restored, so nothing is stranded.
 *
 * (2) At the 1000-entry cap the OLDEST entry was evicted, which for a TOMBSTONED
 * component was permanent loss — an uninstalled row has no "next natural change"
 * left to re-select it, so the tracker was its only re-drive. Eviction now takes
 * the oldest RE-DRIVABLE entry, and when none is left the admission is refused
 * AND the cursor is held rather than advanced past the untracked id. Holding is
 * what keeps the never-dropped invariant true: advancing past a row the tracker
 * declined to take responsibility for is precisely what makes the loss
 * permanent. The cost is that this batch head-of-line-blocks — reachable only
 * once the cap is full of still-failing tombstones, which is already a lane
 * emergency, and a stalled lane that names itself is recoverable where a
 * silently dropped row is not.
 *
 * **That block has no in-process exit; a RESTART is the only one** (marisolashgrove
 * review). Read literally, "head-of-line blocking" implies the head eventually
 * clears, and this head cannot: `quarantined` is set only by
 * {@link ComponentSyncDeadLetterTracker.noteReattemptResult} and cleared only by
 * a fresh insert, so once the cap holds 1000 tombstones that have each burned
 * {@link COMPONENT_DEAD_LETTER_MAX_ATTEMPTS}, `takeDueDeadLetters` skips every
 * one of them for the rest of the process — none can succeed, none is evictable,
 * every admission is refused, and the lane delivers nothing at all. Only
 * {@link ComponentSyncDeadLetterTracker.seedDeadLetters} un-quarantines, and it
 * runs at hydration. So "recoverable" above means a human can see it and restart,
 * NOT that the lane heals itself. No escape hatch is built for it deliberately:
 * the state needs 1000 simultaneously-failing tombstones, and inventing a
 * self-clearing path for it would trade a loud stall for a quiet drop.
 *
 * This mirrors the session lane's `deadLetteredIds` Map + `recoverExpiredDeadLetters`
 * precedent (progressive backoff, retry-after deadlines, a `.size` signal folded
 * into `getSyncProgress`) and the in-file oversized-component dead-letter
 * precedent in `desktop-components-client.ts`, extracted to its own module so the
 * grandfathered `agent-session-sync-service.ts` does not grow.
 */

import type { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import type { SyncedComponent } from "@repo/api/src/types/agent-session";
import { exponentialBackoffMs } from "../../shared/exponential-backoff.js";
import type { TransitionLogger } from "../diagnostics/component-sync-diagnostics.js";
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { ComponentDeadLetterRecord } from "./agent-component-dead-letter-persistence.js";

/** The component lane's in-memory keyset cursor position. `watermark` is the
 * normalized `COALESCE(last_seen_at,'')` of the last-processed row and `lastId`
 * is that row's id; together they are the `(ts, id)` pair the next read pages
 * STRICTLY AFTER. `null` means not-yet-initialized (first tick reads from
 * `('', '')`). */
export type ComponentSyncCursorPosition = {
  watermark: string | null;
  lastId: string | null;
};

/** A cursor row carrying the keyset fields the advance reads. Matches the
 * service's `AgentComponentCursorRow` shape without importing it (avoids a
 * cycle: the service imports this module). */
type ComponentCursorRowLike = {
  id: string;
  last_seen_at: string | null;
  /** ISS-11327: the SQL-projected keyset ranking key, when the source supplies one. */
  cursor_key?: string;
};

/** Persist callback for the durable cursor row; a no-op-safe subset of the
 * service's `AgentSessionSyncSource.advanceSyncState`. */
export type AdvanceCursorPersist = (
  sourceKey: string,
  state: {
    observedTopUpdatedAt: string;
    observedIdsAtTopUpdatedAt: string[];
    deadLetteredIds: string[];
    /** ISS-8593: the per-id bookkeeping riding on the same row. Additive and
     * optional — `deadLetteredIds` stays the membership record. */
    deadLetterAttempts?: ComponentDeadLetterRecord[];
  }
) => unknown;

/**
 * ISS-5347: how the durable cursor persist for one advance actually resolved.
 *
 * The advance below is intentionally best-effort — a persist failure must never
 * throw through into the lane's drain — but "best effort" had meant "silently
 * discarded". A rejected persist, or a missing persist callback, left the
 * IN-MEMORY keyset advanced while the durable `sync_state` row stayed where it
 * was, with no log, no counter, and no state anywhere to notice it. On Marisol's
 * live install that divergence ran for three days: the lane logged
 * `synced N agent component(s) to cloud inventory` 1,713 times in one day while
 * the `agent_components:<target>` cursor row still read
 * `observed_top_updated_at = 2026-08-03T20:56:53Z` / `data_revision = 65`
 * against a current `DATA_REVISION` of 68 — so every db-host restart re-walked
 * the whole inventory from the stale position and re-uploaded it.
 *
 * Reporting the outcome is what makes that condition observable. It does NOT
 * change the advance's control flow: the in-memory position still moves, and the
 * persist is still fire-and-forget.
 */
export const ComponentCursorPersistOutcome = {
  /** The durable row was written. */
  Persisted: "persisted",
  /** No persist callback was supplied, so nothing durable was written. */
  Unavailable: "unavailable",
  /** A persist callback ran and rejected. */
  Failed: "failed",
  /**
   * The advance was a no-op — the keyset position did not move, so no durable
   * write was attempted and the durable row is not out of date because of it.
   *
   * Reporting this (rather than staying silent) makes the observer contract
   * TOTAL: exactly one outcome per {@link advanceComponentCursor} call. Without
   * it a caller could not tell "this advance is still persisting" from "this
   * advance never attempted a persist", which is what an awaitable persist
   * completion needs to distinguish (whitlockk review).
   */
  Unchanged: "unchanged",
} as const;
export type ComponentCursorPersistOutcome =
  (typeof ComponentCursorPersistOutcome)[keyof typeof ComponentCursorPersistOutcome];

/**
 * ISS-5347: observer for the durable-cursor persist attempt of one advance.
 * Optional and additive — callers that do not pass one keep the previous
 * (silent) behavior exactly.
 */
export type ComponentCursorPersistObserver = (
  outcome: ComponentCursorPersistOutcome,
  error?: unknown
) => void;

/**
 * ISS-5347: the keyset position one durable-cursor persist is writing, plus the
 * dead-letter ids that ride along on the same row. Shared by the advance path
 * and the lane's retry of a previously-failed persist.
 */
export type ComponentCursorPersistPosition = {
  watermark: string;
  lastId: string;
  /** ISS-8593: the whole dead-letter snapshot. The durable row's id list is
   * DERIVED from it here, so the ids and their bookkeeping cannot disagree. */
  deadLetters: readonly ComponentDeadLetterRecord[];
};

/** After this many consecutive failures on the SAME keyset boundary, the batch
 * at that boundary is dead-lettered to the back of the line so the lane can
 * advance. Small so a genuinely-permanent failure (403/schema-drift) unblocks
 * quickly, but > 1 so a single transient blip does not eagerly dead-letter. */
export const COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD = 3 as const;

/** Base retry-after window for a dead-lettered component id. Doubles on each
 * failed re-attempt of the same id up to {@link COMPONENT_DEAD_LETTER_RETRY_MAX_MS}. */
export const COMPONENT_DEAD_LETTER_RETRY_BASE_MS = 5 * 60 * 1000; // 5 min

/** Cap for the doubling dead-letter re-attempt window. */
export const COMPONENT_DEAD_LETTER_RETRY_MAX_MS = 24 * 60 * 60 * 1000; // 24 h

/** After this many failed re-attempts of the SAME dead-lettered id, it is
 * QUARANTINED (parked): no longer auto-retried this process lifetime, so a truly
 * poison row cannot spin forever. It still re-syncs on its next natural change or
 * a cold restart — nothing is hard-dropped. */
export const COMPONENT_DEAD_LETTER_MAX_ATTEMPTS = 5 as const;

/** Upper bound on the number of dead-lettered ids retained in memory, mirroring
 * the session lane's `MAX_DEAD_LETTERED_IDS`. The Map can never exceed it, so a
 * pathological run cannot grow it unbounded.
 *
 * ISS-8593: WHICH entry gives up its slot is no longer "the oldest". Eviction is
 * only safe for an entry something else can re-drive — a live component re-enters
 * the keyset lane on its next `last_seen_at` advance — and a TOMBSTONED entry has
 * no such advance left, so evicting one was permanent loss. The victim is now the
 * oldest RE-DRIVABLE entry, and when none is left the incoming entry is refused
 * instead. See {@link ComponentSyncDeadLetterTracker.refusedAdmissions}. */
export const COMPONENT_MAX_DEAD_LETTERED_IDS = 1000 as const;

/** NUL separator for the composite keyset-boundary key. NUL can never appear in
 * an ISO timestamp or a component id, so the join is unambiguous. */
const BOUNDARY_KEY_SEPARATOR = "\u0000";

/**
 * Build the stable key identifying the keyset boundary a batch was read from —
 * the `(sinceTs, sinceId)` position the failing batch is stuck behind. Failures
 * are counted against THIS identity (the "part identity that is retried" per the
 * repo AGENTS.md), so advancing past the batch naturally resets the counter for
 * the next boundary.
 */
export function buildComponentBoundaryKey(
  sinceTs: string,
  sinceId: string
): string {
  return `${sinceTs}${BOUNDARY_KEY_SEPARATOR}${sinceId}`;
}

/**
 * Progressive retry-after window: `BASE * 2^(attempts-1)`, capped.
 *
 * PLN-1562: this used to re-derive the ladder inline (exponent clamp + finite
 * guard + cap). It now delegates to the shared {@link exponentialBackoffMs}
 * (FEA-3795), which computes exactly that and already hardens both edges — so
 * this schedule, the transcript-file ladder, the session dead-letter ladder, and
 * the invocation-part ladder are one source of truth instead of four copies that
 * can drift apart.
 */
export function componentDeadLetterRetryDelayMs(attempts: number): number {
  return exponentialBackoffMs(
    attempts,
    COMPONENT_DEAD_LETTER_RETRY_BASE_MS,
    COMPONENT_DEAD_LETTER_RETRY_MAX_MS
  );
}

/** Per-id dead-letter bookkeeping: the next time it may be re-attempted, how
 * many re-attempts have already failed, whether it has been quarantined, and
 * (ISS-8593) whether anything OTHER than this tracker could re-drive it. */
type DeadLetterEntry = {
  retryAfterMs: number;
  attempts: number;
  quarantined: boolean;
  /** False for a TOMBSTONED component — see {@link ComponentDeadLetterRecord.tombstoned}
   * for why such a row has no "next natural change" and must not be evicted. */
  redrivable: boolean;
};

/**
 * Tracks the component-sync lane's per-boundary failure budget and the resulting
 * dead-lettered component ids. Pure and injection-free so it is unit-testable in
 * isolation with fake timers; the sync service owns one instance per lane and
 * resets it on identity change / stop.
 */
export class ComponentSyncDeadLetterTracker {
  /** Consecutive failure count per keyset boundary key. Cleared when that
   * boundary's batch finally sends, or when the boundary is dead-lettered. */
  private readonly boundaryFailures = new Map<string, number>();
  /** Dead-lettered component ids → their retry bookkeeping. Insertion order is
   * preserved so the oldest entry is evicted first at the size cap. */
  private readonly deadLettered = new Map<string, DeadLetterEntry>();
  /** ISS-8593: how many admissions the size cap has refused because every
   * tracked entry was a tombstone. Monotonic for this tracker's whole lifetime
   * (NOT reset by {@link clear}) so a caller can compare it across one call and
   * report the refusal — a refused admission is a row this lane can no longer
   * re-drive itself, which must never pass silently. */
  private refusals = 0;
  /** ISS-8593 (whitlockk review): bumped once per mutation of {@link deadLettered}.
   * A caller straddling a step that can change the set — the drained-cursor
   * recovery, which admits nothing and advances no cursor — reads this before
   * and after to learn whether the snapshot it already persisted is now stale
   * and owes a durable write. Monotonic for this tracker's lifetime; the VALUE
   * is meaningless, only inequality across one call is. */
  private mutations = 0;

  /**
   * Record a failed send for the batch read at `boundaryKey`, carrying the ids
   * that were in that batch. Returns `true` when the boundary has now failed
   * {@link COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD} times in a row and its ids
   * were moved to the dead-letter set (so the caller must advance the cursor
   * PAST this batch); `false` while the batch should keep retrying in place.
   *
   * `tombstonedIds` (ISS-8593) names the subset of `batchIds` whose local row is
   * already tombstoned. Optional and defaulting to empty: a caller that cannot
   * tell (a fake source, a cursor row read by a build without the column) gets
   * exactly the pre-ISS-8593 eviction behavior rather than a wrong answer.
   *
   * Returns `false` — keep retrying in place — when the size cap REFUSED any of
   * the ids as well as when the budget is not yet spent. Advancing past an id
   * the tracker did not take responsibility for is what turns a refusal into a
   * permanent drop, so the two "do not advance" cases deliberately share one
   * answer; {@link refusedAdmissions} tells them apart for the diagnostic.
   */
  recordBatchFailure(
    boundaryKey: string,
    batchIds: readonly string[],
    nowMs: number,
    tombstonedIds?: ReadonlySet<string>
  ): boolean {
    const next = (this.boundaryFailures.get(boundaryKey) ?? 0) + 1;
    if (next < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD) {
      this.boundaryFailures.set(boundaryKey, next);
      return false;
    }
    // Threshold reached: dead-letter every id in the batch to the back of the
    // line and clear the boundary counter.
    //
    // The counter is cleared UNCONDITIONALLY, which is right on the admitted path
    // (the cursor is about to move past this boundary) but is a real cost on the
    // refusal path below, where `false` holds the cursor here (marisolashgrove
    // review): the batch that was refused must burn another
    // COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD failures before it even re-attempts
    // the admission. Left as-is on purpose — the alternative, retrying admission
    // on the very next failure, spins the refusal path at the tick interval, and
    // the refusal path is already the all-tombstones lane emergency described in
    // the module header.
    this.boundaryFailures.delete(boundaryKey);
    let admittedAll = true;
    for (const id of batchIds) {
      const admitted = this.enqueueDeadLetter(
        id,
        nowMs,
        0,
        tombstonedIds?.has(id) !== true
      );
      admittedAll = admittedAll && admitted;
    }
    return admittedAll;
  }

  /**
   * Note that the batch at `boundaryKey` finally sent: clear its consecutive
   * failure count so a later, unrelated failure at the same boundary starts the
   * budget fresh instead of inheriting a stale near-threshold count.
   */
  clearBoundary(boundaryKey: string): void {
    this.boundaryFailures.delete(boundaryKey);
  }

  /**
   * Return the dead-lettered ids that are DUE for a re-attempt now: retry-after
   * window elapsed and not yet quarantined. The caller invokes this ONLY when
   * the live cursor is drained AND no newer incremental has entered, so live
   * data is never starved by a poison backlog item. Bounded to `limit` ids.
   */
  takeDueDeadLetters(nowMs: number, limit: number): string[] {
    const due: string[] = [];
    for (const [id, entry] of this.deadLettered) {
      if (due.length >= limit) {
        break;
      }
      if (!entry.quarantined && entry.retryAfterMs <= nowMs) {
        due.push(id);
      }
    }
    return due;
  }

  /**
   * Record the outcome of a dead-letter re-attempt for `ids`. On success the ids
   * leave the dead-letter set (they reached the cloud). On failure each id's
   * attempt count and backoff advance; once an id reaches
   * {@link COMPONENT_DEAD_LETTER_MAX_ATTEMPTS} it is QUARANTINED (parked, no
   * longer auto-retried) rather than spinning forever.
   */
  noteReattemptResult(
    ids: readonly string[],
    succeeded: boolean,
    nowMs: number
  ): void {
    for (const id of ids) {
      if (succeeded) {
        // Bump only when an entry was actually removed: an id already gone (a
        // cleared tracker, a duplicate report) changed nothing, and counting it
        // would bill a durable write to a snapshot that never moved.
        if (this.deadLettered.delete(id)) {
          this.mutations += 1;
        }
        continue;
      }
      const entry = this.deadLettered.get(id);
      if (!entry) {
        continue;
      }
      entry.attempts += 1;
      this.mutations += 1;
      if (entry.attempts >= COMPONENT_DEAD_LETTER_MAX_ATTEMPTS) {
        entry.quarantined = true;
        // Park it out of the auto-retry window; a natural change or cold restart
        // re-syncs it. INFINITE keeps `takeDueDeadLetters` from ever picking it.
        entry.retryAfterMs = Number.POSITIVE_INFINITY;
      } else {
        entry.retryAfterMs =
          nowMs + componentDeadLetterRetryDelayMs(entry.attempts);
      }
    }
  }

  /** Live count of dead-lettered component ids (including quarantined), surfaced
   * as `deadLetteredComponents` in `getSyncProgress`. */
  get size(): number {
    return this.deadLettered.size;
  }

  /** ISS-8593: admissions the size cap refused because nothing re-drivable was
   * left to evict. Monotonic for this tracker's lifetime; see {@link refusals}. */
  get refusedAdmissions(): number {
    return this.refusals;
  }

  /** ISS-8593 (whitlockk review): mutation counter for the dead-letter set; see
   * {@link mutations}. Compare across a call, never against a stored constant. */
  get revision(): number {
    return this.mutations;
  }

  /** Snapshot of the current dead-letter set, persisted onto the durable cursor
   * row so a cold restart can re-drive it even after the monotonic cursor has
   * advanced past those `(ts, id)` positions — true never-drop across restarts,
   * not just re-sync-on-change.
   *
   * ISS-8593: this used to be bare ids. It now carries each entry's `attempts`
   * and `tombstoned` flag as well, which is what lets {@link seedDeadLetters}
   * restore the backoff POSITION and the eviction protection instead of resetting
   * both on every launch. The id list persisted alongside it is derived from
   * these records, so the two can never disagree. */
  deadLetterState(): ComponentDeadLetterRecord[] {
    return [...this.deadLettered].map(([id, entry]) => ({
      id,
      attempts: entry.attempts,
      tombstoned: !entry.redrivable,
      // A QUARANTINED entry's deadline is INFINITE, which is not a JSON number —
      // omit it rather than serialize a null the reader would have to re-invent
      // a meaning for. Seeding un-quarantines anyway, so such an entry resumes
      // from a fresh window computed off `attempts`, which is correct for it.
      ...(Number.isFinite(entry.retryAfterMs)
        ? { retryAfterEpochMs: entry.retryAfterMs }
        : {}),
    }));
  }

  /**
   * Re-seed the dead-letter set from a persisted snapshot on hydration (identity
   * change / first run). `ids` is the membership record; `records` (ISS-8593) is
   * the optional per-id bookkeeping, joined on id — a record naming an id not in
   * `ids` is ignored, and an id with no record seeds at attempt 0 exactly as it
   * did before that column existed.
   *
   * A re-seeded entry resumes its BACKOFF (`attempts` restored, and the deadline
   * it was already waiting on honored) rather than being due immediately. That
   * is the point: a restart used to reset every entry to due-immediately, so a
   * row that had backed off to the 24h ceiling was re-hammered on every launch.
   *
   * The resumed deadline is CLAMPED AT BOTH ENDS to `[nowMs, nowMs +
   * delay(attempts)]`. The lower bound turns a deadline that elapsed while the
   * app was closed into due-now — closed time counts, so a process whose
   * lifetime is shorter than the window still re-drives. The upper bound means a
   * corrupt or far-future deadline (a backwards clock change, a hand-edited row)
   * can delay an entry by at most one full window and can never strand it, which
   * is what keeps the never-permanently-stranded guarantee unconditional rather
   * than dependent on a stored instant being sane.
   *
   * Quarantine is deliberately NOT restored. A cold restart still re-drives a
   * previously-parked poison item — just at its earned backoff instead of
   * instantly — so the never-permanently-stranded guarantee is unchanged and the
   * item simply re-quarantines on its next failure.
   *
   * An id already tracked keeps its in-flight bookkeeping, so a live snapshot
   * never resets a backoff mid-flight — except that a record marking it a
   * tombstone still upgrades the eviction protection, which can only be gained.
   */
  seedDeadLetters(
    ids: readonly string[],
    nowMs: number,
    records?: readonly ComponentDeadLetterRecord[],
    recordsWereDropped = false
  ): void {
    const byId = new Map(
      (Array.isArray(records) ? records : []).map((record) => [
        record.id,
        record,
      ])
    );
    for (const id of ids) {
      const record = byId.get(id);
      this.enqueueDeadLetter(
        id,
        nowMs,
        record?.attempts ?? 0,
        // ISS-8593 (marisolashgrove review): an id whose record SURVIVED is judged
        // by that record, unchanged. An id with NO record is the decision, and
        // it turns on whether the codec actually lost anything on this read:
        //
        //  - nothing dropped → re-drivable, the pre-ISS-8593 behavior. An id can
        //    legitimately have no record (a cursor older than migration 0080, or
        //    an id dead-lettered after the last snapshot), and protecting those
        //    would pin every legacy cursor's whole set in the tracker for good.
        //  - records dropped → PROTECTED. This id may be one of them, and the
        //    two costs are not symmetric: an over-protected row is merely not
        //    evicted, which the next healthy snapshot corrects, while an
        //    under-protected tombstone is destroyed permanently — its ordering
        //    key never rises again, so nothing re-drives it and the
        //    protection-on-next-encounter path cannot rescue it. Fail toward the
        //    recoverable error.
        record ? record.tombstoned !== true : !recordsWereDropped,
        record?.retryAfterEpochMs
      );
    }
  }

  /** True once at least one dead-letter is due for a re-attempt at `nowMs`, so
   * the caller only re-reads their rows when there is work to do. */
  hasDueDeadLetters(nowMs: number): boolean {
    for (const entry of this.deadLettered.values()) {
      if (!entry.quarantined && entry.retryAfterMs <= nowMs) {
        return true;
      }
    }
    return false;
  }

  /** Clear every boundary counter and dead-letter entry (identity change / stop). */
  clear(): void {
    this.boundaryFailures.clear();
    if (this.deadLettered.size > 0) {
      this.deadLettered.clear();
      this.mutations += 1;
    }
  }

  /**
   * Move `id` into the dead-letter set at `attempts`, or — if already present —
   * leave its escalating bookkeeping intact so re-batching the same id does not
   * reset its backoff.
   *
   * `attempts` 0 is due immediately once the lane is drained (the initial
   * dead-letter is a deferral to the back of the line, not a delay); a restored
   * count resumes that id's earned backoff window instead.
   *
   * At the cap the entry is admitted only if {@link evictForAdmission} can free a
   * slot without losing a row nothing else will re-drive.
   */
  private enqueueDeadLetter(
    id: string,
    nowMs: number,
    attempts: number,
    redrivable: boolean,
    retryAfterEpochMs?: number
  ): boolean {
    const existing = this.deadLettered.get(id);
    if (existing) {
      // ISS-8593: a row can be tombstoned AFTER it was dead-lettered while
      // installed — the tombstone re-keys it above the cursor, so the lane meets
      // it again and this time knows it is a tombstone. Take that fact: eviction
      // protection can only be GAINED here, never lost, or the entry would keep
      // a stale `redrivable: true` and stay an eviction candidate for a row
      // nothing can re-drive. The backoff bookkeeping is still left alone.
      if (!redrivable) {
        existing.redrivable = false;
        this.mutations += 1;
      }
      return true;
    }
    if (
      this.deadLettered.size >= COMPONENT_MAX_DEAD_LETTERED_IDS &&
      !this.evictForAdmission()
    ) {
      this.refusals += 1;
      return false;
    }
    this.deadLettered.set(id, {
      retryAfterMs: resumedRetryAfterMs(nowMs, attempts, retryAfterEpochMs),
      attempts,
      quarantined: false,
      redrivable,
    });
    this.mutations += 1;
    return true;
  }

  /**
   * ISS-8593: free one slot for an incoming entry, or report that no slot can be
   * freed safely.
   *
   * The victim is the OLDEST RE-DRIVABLE entry — a live component that will
   * re-enter the keyset lane the next time its `last_seen_at` advances, so
   * forgetting it here costs a delay and never a row. A TOMBSTONED entry has no
   * such advance left (see {@link ComponentDeadLetterRecord.tombstoned}), so once
   * admitted it is never evicted: if every tracked entry is a tombstone this
   * returns `false` and the caller refuses the ADMISSION instead, keeping the
   * hard size cap intact while making the loss fall on the row the tracker has
   * not yet taken responsibility for rather than one it already promised to
   * re-drive.
   */
  private evictForAdmission(): boolean {
    for (const [id, entry] of this.deadLettered) {
      if (entry.redrivable) {
        this.deadLettered.delete(id);
        return true;
      }
    }
    return false;
  }
}

/** The outcome of charging a failed component-batch send against its boundary:
 * either the batch was dead-lettered to the back of the line (the caller must
 * advance the cursor PAST it) or it stays in place for a bounded in-place retry. */
export const ComponentSendFailureOutcome = {
  DeadLettered: "dead-lettered",
  RetryInPlace: "retry-in-place",
} as const;
export type ComponentSendFailureOutcome =
  (typeof ComponentSendFailureOutcome)[keyof typeof ComponentSendFailureOutcome];

/**
 * ISS-4542 (davetho review): the CLASS of a component-sync send result, so the
 * lane can tell a component-specific permanent rejection (which SHOULD burn the
 * poison-row budget and eventually dead-letter) apart from a lane-wide failure
 * (auth, no target, transport/network, timeout, rate-limit, server 5xx) that must
 * NOT charge the budget or advance the cursor — an outage or a 401/403 denial
 * would otherwise strand healthy rows and walk the whole inventory forward.
 *
 * - `Accepted`     — 2xx: the whole batch reached the cloud; advance the cursor.
 * - `LaneFailure`  — pause the lane WITHOUT advancing and WITHOUT charging the
 *                    boundary budget; the same rows retry next tick. Covers
 *                    missing credential / compute target / origin, transport &
 *                    timeout errors, and every failed status the shared standard
 *                    does not attribute to the batch itself.
 * - `BatchRejected`— a PERMANENT per-batch rejection the server attributes to the
 *                    batch content itself — Appendix A's `ITEM`. Only THIS class
 *                    charges the boundary budget so a genuine poison batch is
 *                    dead-lettered to the back of the line.
 *
 * WHICH STATUS EARNS WHICH is no longer decided here (ISS-8614). The lane reads
 * the shared standard through `agent-component-sync-classification.ts`, whose
 * profile carries the one place this route departs from Appendix A — the bare
 * 400, which the route returns for a version-skew `schemaVersion` mismatch that
 * 400s every page, so charging it would walk the whole inventory forward and
 * strand it on one side of the skew (davetho review).
 */
export const ComponentSyncSendOutcome = {
  Accepted: "accepted",
  LaneFailure: "lane-failure",
  BatchRejected: "batch-rejected",
} as const;
export type ComponentSyncSendOutcome =
  (typeof ComponentSyncSendOutcome)[keyof typeof ComponentSyncSendOutcome];
/**
 * Result of a component-sync POST (ISS-4542). `outcome` classifies the send;
 * `firstUnsentChunkIndex`/`chunkCount` (meaningful only on a non-`Accepted`
 * outcome) describe how much of the cursor page never reached the cloud — the
 * failing chunk and everything after it — for the diagnostic line. Chunk
 * boundaries are byte-size opaque to the caller's per-row keyset ids, so the
 * caller still dead-letters at the batch's keyset boundary; already-acked earlier
 * chunks upsert idempotently and are never re-processed on the retry. Defined here
 * (not in the client) so the sync service can consume it without importing the
 * client — the client already imports the service, so the reverse would cycle.
 */
export type ComponentSyncSendResult = {
  outcome: ComponentSyncSendOutcome;
  firstUnsentChunkIndex: number | null;
  chunkCount: number;
  /**
   * ISS-6338: why a non-`Accepted` send failed, on the shared closed enum, so
   * the lane's cloud batch event can name it. Optional and additive — an
   * `Accepted` result omits it, and a producer that cannot classify a failure
   * omits it rather than guessing (the consumer then reports the generic
   * transport reason).
   */
  reason?: SyncReason;
  /**
   * ISS-9698: how long the SERVER asked this lane to wait, parsed from the
   * failing response's `Retry-After` header, in milliseconds.
   *
   * Optional and additive for the same reason `reason` is, and read only on the
   * `LaneFailure` arm: it is a floor under the environmental defer gate's staged
   * delay (`LaneEnvironmentalDeferGate.noteEnvironmentalFailure` takes `max`,
   * never `min`), so before this the gate's parameter existed but no production
   * caller supplied it and a 429 asking for 30 minutes was retried after 5.
   *
   * A send that never got a response — a rejected fetch, the request's own
   * timeout — has no header to read and omits this; the staged schedule then
   * owns the delay, which is the correct answer and not a fabricated zero.
   *
   * NOT the same quantity as {@link DeadLetterEntry.retryAfterMs} above, which
   * shares the name and is an ABSOLUTE epoch instant ("when this dead-lettered
   * id becomes retry-eligible", compared as `entry.retryAfterMs <= nowMs`). This
   * one is a RELATIVE duration, matching every other `retryAfterMs` on the
   * desktop→cloud path (`TranscriptSyncClientError`, `laneStallDelayMs`,
   * `noteEnvironmentalFailure`). The two are read a few lines apart in
   * `applySendOutcome`, so check which you have before doing arithmetic on it.
   */
  retryAfterMs?: number;
};

/** Dependencies for {@link handleComponentSendFailure}. */
export type ComponentSendFailureDeps = {
  tracker: ComponentSyncDeadLetterTracker;
  /** The keyset boundary the failing batch was read from. */
  boundaryKey: string;
  /** The component ids in the failing batch (dead-lettered on threshold). */
  batchIds: readonly string[];
  /** ISS-8593: the subset of `batchIds` whose local row is already tombstoned, so
   * the tracker never evicts one at the size cap. Omitted by a caller that cannot
   * tell, which degrades to the pre-ISS-8593 behavior. */
  tombstonedIds?: ReadonlySet<string>;
  /** How many components were in the batch (for the diagnostic message). */
  componentCount: number;
  /** Whether the caller has a last row to advance the cursor past on dead-letter. */
  canAdvance: boolean;
  diag: TransitionLogger;
};

/**
 * ISS-4542: charge a failed component-batch send against its keyset boundary and
 * decide what happens next. Below the bounded threshold the batch stays in place
 * for a retry (a transient blip heals without dead-lettering). Once the boundary
 * has failed the threshold in a row, the batch is DEAD-LETTERED to the back of
 * the line so a PERMANENT failure (a never-clearing 403, schema drift, a poison
 * row) can no longer head-of-line-block the whole lane — everything behind it
 * drains, and the dead-lettered ids are re-attempted only once the lane is
 * otherwise empty. Returns which outcome occurred; the caller advances the cursor
 * on `DeadLettered`.
 */
export function handleComponentSendFailure(
  deps: ComponentSendFailureDeps
): ComponentSendFailureOutcome {
  const {
    tracker,
    boundaryKey,
    batchIds,
    tombstonedIds,
    componentCount,
    canAdvance,
    diag,
  } = deps;
  const refusalsBefore = tracker.refusedAdmissions;
  const deadLettered = tracker.recordBatchFailure(
    boundaryKey,
    batchIds,
    Date.now(),
    tombstonedIds
  );
  // ISS-8593: the size cap could not take these ids without evicting a tombstone
  // nothing else can re-drive, so it refused them. That is a real loss signal —
  // report it on the lane's own diagnostic channel rather than letting the ids
  // disappear between two counters that both still look healthy.
  const refused = tracker.refusedAdmissions - refusalsBefore;
  if (refused > 0) {
    // The cursor must NOT advance past an id the tracker refused. Advancing is
    // what makes a refusal permanent: a TOMBSTONED row's ordering key never
    // rises again, so nothing would ever re-select it. Holding the cursor
    // head-of-line-blocks this batch — the condition ISS-4542 exists to avoid —
    // but it is reachable only when the cap is FULL of tombstones that are all
    // still failing, which is already a lane emergency, and a stalled lane that
    // says so is recoverable where a silently dropped row is not.
    diag.note(
      "warn",
      "dead-letter-cap-refused",
      `dead-letter set is at its ${COMPONENT_MAX_DEAD_LETTERED_IDS}-entry cap and holds only rows nothing else can re-drive; ${refused} component id(s) could not be tracked, so the cursor is HELD here rather than advancing past them`
    );
  }
  // `deadLettered` is false on a refusal (see `recordBatchFailure`), so the
  // refusal falls through to the retry-in-place answer below and the cursor
  // stays put. That is ONE mechanism rather than two: an early return here
  // would be a second, independently-mutable way to reach the same outcome.
  if (deadLettered && canAdvance) {
    diag.note(
      "warn",
      "batch-dead-lettered",
      `dead-lettered ${batchIds.length} component(s) after repeated send failures; advancing past them so the lane drains — they will be re-attempted once the lane is otherwise empty`
    );
    return ComponentSendFailureOutcome.DeadLettered;
  }
  diag.note(
    "warn",
    "not-accepted",
    `sendComponents rejected ${componentCount} component(s) (see components-sync-client log for the reason); retrying in place before dead-lettering`
  );
  return ComponentSendFailureOutcome.RetryInPlace;
}

/** Dependencies for {@link recoverComponentDeadLetters}. The caller injects the
 * lane's tracker, the (already-resolved) send/load transport, the batch limit,
 * and its diagnostics logger — so the recovery step lives entirely in this
 * module and does not grow the grandfathered sync service. */
export type ComponentDeadLetterRecoveryDeps = {
  tracker: ComponentSyncDeadLetterTracker;
  /** Max ids to re-attempt in one drained pass (the component batch size). */
  batchLimit: number;
  /** Load the `SyncedComponent` rows for the given ids (never throws through). */
  loadComponentRows: (ids: string[]) => Promise<SyncedComponent[]>;
  /** POST the loaded rows; resolves a {@link ComponentSyncSendResult} classifying
   * the send so a lane-wide failure during recovery does NOT advance the row's
   * backoff toward quarantine (only a permanent per-batch rejection does). */
  sendComponents: (
    components: SyncedComponent[]
  ) => Promise<ComponentSyncSendResult>;
  diag: TransitionLogger;
  /** Log tag for the info recovery line (mirrors the lane's `gatewayLog` tag). */
  logTag: string;
  /** ISS-4542 (whitlockk review): supersession guard. Returns `false` once the lane's
   * source-state generation has moved (a `resetSourceState()` cleared the tracker
   * for a new identity) so a load/send await that resolves late does NOT record its
   * outcome against the now-cleared/next-identity tracker. Defaults to always-current
   * for callers (e.g. unit tests) that do not need supersession. */
  isCurrent?: () => boolean;
};

/**
 * ISS-4542: re-attempt dead-lettered component ids. Called ONLY when the live
 * cursor is drained (no newer/incremental work is pending) — this is what keeps
 * a poison backlog item from ever starving live data. Loads the DUE ids
 * (retry-after window elapsed, not quarantined), sends them as one best-effort
 * batch, and records the outcome so a success clears them while a failure
 * advances their bounded backoff toward quarantine. Returns `true` when a
 * re-attempt actually ran, so the caller suppresses the idle "nothing to upload"
 * transition this tick.
 */
export async function recoverComponentDeadLetters(
  deps: ComponentDeadLetterRecoveryDeps
): Promise<boolean> {
  const {
    tracker,
    batchLimit,
    loadComponentRows,
    sendComponents,
    diag,
    logTag,
    isCurrent,
  } = deps;
  const nowMs = Date.now();
  const dueIds = tracker.takeDueDeadLetters(nowMs, batchLimit);
  if (dueIds.length === 0) {
    return false;
  }
  let components: SyncedComponent[];
  try {
    components = await loadComponentRows(dueIds);
  } catch (error) {
    diag.note(
      "warn",
      "dead-letter-load-failed",
      `loading ${dueIds.length} dead-lettered component row(s) failed: ${errorMessage(error)}`
    );
    return true;
  }
  if (components.length === 0) {
    // ISS-4542 (whitlockk review): an empty load is AMBIGUOUS. `app.ts`'s
    // `loadComponentRows` returns `[]` both when the rows are genuinely gone
    // (purged) AND when the DB host is temporarily unavailable (`syncSource` is
    // null → `?? []`). We cannot tell them apart here, and the never-drop
    // invariant means we must NOT drop the dead-letter ids on a transient DB
    // outage. So leave them tracked and due — a genuinely-purged row is harmlessly
    // re-loaded (still empty) on the next drain until a natural change or a cold
    // restart clears it, while a temporarily-unavailable DB never silently loses
    // the backlog. Do NOT advance the backoff (an empty load is not the row's
    // fault, exactly like a lane-wide failure).
    diag.note(
      "warn",
      "dead-letter-load-empty",
      `dead-letter re-attempt loaded 0 rows for ${dueIds.length} due id(s); leaving them queued (DB may be temporarily unavailable — never dropped)`
    );
    return true;
  }
  // ISS-4623 (davetho review): re-check freshness IMMEDIATELY before the
  // dead-letter send, not only after it. `isCurrent` now folds in the live egress
  // gate + compute target (see `isCurrentComponentState`), so a policy close or
  // account switch landing during the `loadComponentRows` await above aborts the
  // re-attempt BEFORE this POST rather than egressing the batch and only skipping
  // the outcome recording. Report a pass ran (suppresses the idle transition);
  // the ids stay due and re-attempt on a later drain once the gate reopens.
  if (isCurrent && !isCurrent()) {
    return true;
  }
  let sendResult: ComponentSyncSendResult;
  try {
    sendResult = await sendComponents(components);
  } catch (error) {
    // A thrown send is lane-wide (dropped socket / serialization) — do NOT charge
    // the row's backoff toward quarantine; retry on the next drained pass.
    diag.note(
      "warn",
      "dead-letter-send-threw",
      `dead-letter re-attempt threw for ${components.length} component(s): ${errorMessage(error)}; lane-wide, not counting against the row's retry budget`
    );
    return true;
  }
  // ISS-4542 (whitlockk review): the recovery send await may have resolved AFTER a
  // `resetSourceState()` cleared this tracker for a new identity. If so, do NOT
  // record this outcome against the fresh tracker — the ids we re-attempted no
  // longer belong to it. Report that a pass ran (suppresses the idle transition)
  // but touch no state.
  if (isCurrent && !isCurrent()) {
    return true;
  }
  if (sendResult.outcome === ComponentSyncSendOutcome.Accepted) {
    tracker.noteReattemptResult(dueIds, true, nowMs);
    diag.set("ok");
    gatewayLog.info(
      logTag,
      `re-synced ${components.length} dead-lettered agent component(s) to cloud inventory`
    );
    return true;
  }
  if (sendResult.outcome === ComponentSyncSendOutcome.LaneFailure) {
    // ISS-4542 (davetho review): a lane-wide failure during recovery (auth /
    // transport / 429 / 5xx) is NOT the row's fault — do not advance its backoff
    // or push it toward quarantine. Leave the entry due and retry next drain.
    diag.note(
      "warn",
      "dead-letter-reattempt-lane-failure",
      `dead-letter re-attempt hit a lane-wide failure for ${components.length} component(s) (see components-sync-client log); not counting against the row's retry budget`
    );
    return true;
  }
  // BatchRejected: a genuine permanent per-batch rejection — advance the bounded
  // backoff toward quarantine.
  tracker.noteReattemptResult(dueIds, false, nowMs);
  diag.note(
    "warn",
    "dead-letter-reattempt-failed",
    `dead-letter re-attempt permanently rejected ${components.length} component(s); backing off (bounded — quarantined after the attempt cap)`
  );
  return true;
}

/**
 * Advance the component KEYSET cursor to the LAST row of the just-processed
 * batch — NOT `max(last_seen_at)`. The batch is ordered by (last_seen_at, id)
 * ASC, so its last element is the highest `(ts, id)` pair. Advancing to that pair
 * guarantees forward progress even when all rows share one `last_seen_at` (the id
 * strictly increases within the cluster), so the next tick reads STRICTLY AFTER
 * it and the lane pages to completion instead of re-uploading the same batch
 * forever. A row whose `last_seen_at` later advances past this position is
 * naturally re-selected (re-sync-on-change). Returns the new in-memory cursor
 * position and, when it actually moved, fires the durable persist best-effort —
 * carrying the current dead-letter ids (ISS-4542) so a cold restart can re-drive
 * a poison item the monotonic cursor has already advanced past. Shared by the
 * accepted-send path and the dead-letter path (which advances PAST a failing
 * batch to unblock the lane).
 */
export function advanceComponentCursor(
  current: ComponentSyncCursorPosition,
  lastRow: ComponentCursorRowLike,
  sourceKey: string,
  persist: AdvanceCursorPersist | undefined,
  deadLetters: readonly ComponentDeadLetterRecord[],
  onPersistOutcome?: ComponentCursorPersistObserver
): ComponentSyncCursorPosition {
  // ISS-11327: the cursor advances onto the row's RANKING KEY, not its raw
  // `last_seen_at`, because that is the value the next read's keyset predicate
  // compares. The key is the one the SQL PROJECTED — persisting the very value the
  // next comparison will use is what makes the round trip exact — and it is never
  // re-derived here: the JS mirror lives under `src/main/database/**`, which this
  // boot-reachable module may not import (tamsinb review).
  //
  // The fallback is the pre-ISS-11327 raw value, and the ONLY source that reaches it
  // is an injected test fake: the real reader projects the key in SQL, and the db
  // host is forked from this same bundle, so main and host can never disagree about
  // whether the column is there. `component-sync-lane-fixture.ts` projects it too, so
  // a fixture-driven lane test walks the ranked order production walks.
  const watermark = lastRow.cursor_key ?? lastRow.last_seen_at ?? "";
  const lastId = lastRow.id;
  const advanced = watermark !== current.watermark || lastId !== current.lastId;
  if (advanced) {
    persistComponentCursorPosition(
      persist,
      sourceKey,
      // ISS-4542: persist the component lane's dead-lettered ids onto the
      // durable cursor row so a cold restart re-drives them even after the
      // cursor has advanced past their (ts, id) position. ISS-8593: with each
      // id's attempts + tombstone flag, so the restart resumes their backoff.
      { watermark, lastId, deadLetters },
      onPersistOutcome
    );
  } else {
    reportPersistOutcome(
      onPersistOutcome,
      ComponentCursorPersistOutcome.Unchanged
    );
  }
  return { watermark, lastId };
}

/**
 * ISS-5347: issue ONE durable-cursor persist for `position` and report exactly
 * one {@link ComponentCursorPersistOutcome} for it.
 *
 * Split out of {@link advanceComponentCursor} (whitlockk review) because the advance
 * is no longer the only caller: a persist that FAILED leaves the lane holding an
 * unpersisted position that nothing else would ever re-attempt once the cursor
 * drains, so the lane retries that exact position through this function without
 * a new row to advance past.
 *
 * The write stays fire-and-forget — a persist failure must never throw through
 * into the lane's drain. `Promise.resolve(...)` normalizes the possibly-sync
 * persist return so the settle handlers swallow any rejection. No `void`
 * operator: `noVoid` is enforced for this module and the trailing `.catch`
 * already discards the settled value.
 */
export function persistComponentCursorPosition(
  persist: AdvanceCursorPersist | undefined,
  sourceKey: string,
  position: ComponentCursorPersistPosition,
  onPersistOutcome?: ComponentCursorPersistObserver
): void {
  if (!persist) {
    // An advance with NO persist callback moved the in-memory keyset and wrote
    // nothing durable. That is the silent-divergence case, so it is reported
    // rather than being indistinguishable from a successful persist.
    reportPersistOutcome(
      onPersistOutcome,
      ComponentCursorPersistOutcome.Unavailable
    );
    return;
  }
  const deadLetters = [...position.deadLetters];
  Promise.resolve(
    persist(sourceKey, {
      observedTopUpdatedAt: position.watermark,
      observedIdsAtTopUpdatedAt: [position.lastId],
      // The membership list every reader (including a build that predates
      // ISS-8593) uses, derived from the same snapshot as the bookkeeping.
      deadLetteredIds: deadLetters.map((record) => record.id),
      deadLetterAttempts: deadLetters,
    })
  )
    .then(
      () =>
        reportPersistOutcome(
          onPersistOutcome,
          ComponentCursorPersistOutcome.Persisted
        ),
      (error: unknown) =>
        reportPersistOutcome(
          onPersistOutcome,
          ComponentCursorPersistOutcome.Failed,
          error
        )
    )
    .catch(() => undefined);
}

/**
 * ISS-8593: the deadline a re-seeded dead-letter resumes at.
 *
 * `attempts` 0 with no recorded deadline is due immediately — the initial
 * dead-letter is a deferral to the back of the line, not a delay. Otherwise the
 * entry resumes the deadline it was already waiting on, CLAMPED AT BOTH ENDS to
 * `[nowMs, nowMs + delay(attempts)]`.
 *
 * The lower clamp is what makes time the app spent CLOSED count: a deadline that
 * elapsed while the process was down comes back due-now, so a process whose
 * lifetime is shorter than the window still re-drives the entry. Without it a
 * resumed window restarted its clock at every hydration and an entry high on the
 * ladder was re-driven NEVER — for a tombstoned row, exactly the permanent
 * stranding this field set exists to prevent.
 *
 * The upper clamp bounds the damage a bogus stored instant can do: a backwards
 * clock change or a hand-edited row can delay the entry by at most one full
 * window and can never park it past the ladder's own ceiling.
 */
function resumedRetryAfterMs(
  nowMs: number,
  attempts: number,
  retryAfterEpochMs: number | undefined
): number {
  const window = attempts > 0 ? componentDeadLetterRetryDelayMs(attempts) : 0;
  if (retryAfterEpochMs === undefined) {
    return nowMs + window;
  }
  return Math.min(Math.max(retryAfterEpochMs, nowMs), nowMs + window);
}

/**
 * Hand one persist outcome to the optional observer without ever letting the
 * observer's own throw escape (tamsinb review).
 *
 * The Persisted/Failed reports run inside a promise chain whose trailing
 * `.catch` already contained a throwing observer, but the Unavailable report is
 * SYNCHRONOUS: it runs on `advanceComponentCursor`'s own stack, so before this
 * helper a throw there propagated straight out through `applyCursorAdvance` into
 * the lane's `run()` and aborted the tick. Routing all three through one place
 * makes the "a throwing observer cannot escape into the lane's drain" contract
 * true as written instead of true for two paths out of three.
 *
 * The throw is swallowed rather than logged, matching the `.catch(() =>
 * undefined)` that already guarded the async paths: reporting is best-effort
 * diagnostics and must never change the advance's control flow.
 */
function reportPersistOutcome(
  observer: ComponentCursorPersistObserver | undefined,
  outcome: ComponentCursorPersistOutcome,
  error?: unknown
): void {
  try {
    observer?.(outcome, error);
  } catch {
    // Best-effort reporting: an observer defect must not abort the lane tick.
  }
}
