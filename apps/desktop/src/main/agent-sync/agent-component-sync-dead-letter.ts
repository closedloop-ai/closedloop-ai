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
 * restart re-drives even a quarantined item once (fresh window) rather than
 * stranding it past the advanced cursor; it also still re-syncs on the next
 * natural change (its `last_seen_at` advancing past the cursor).
 *
 * This mirrors the session lane's `deadLetteredIds` Map + `recoverExpiredDeadLetters`
 * precedent (progressive backoff, retry-after deadlines, a `.size` signal folded
 * into `getSyncProgress`) and the in-file oversized-component dead-letter
 * precedent in `desktop-components-client.ts`, extracted to its own module so the
 * grandfathered `agent-session-sync-service.ts` does not grow.
 */

import type { SyncedComponent } from "@repo/api/src/types/agent-session";
import { exponentialBackoffMs } from "../../shared/exponential-backoff.js";
import type { TransitionLogger } from "../diagnostics/component-sync-diagnostics.js";
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import { gatewayLog } from "../logging/gateway-logger.js";

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
type ComponentCursorRowLike = { id: string; last_seen_at: string | null };

/** Persist callback for the durable cursor row; a no-op-safe subset of the
 * service's `AgentSessionSyncSource.advanceSyncState`. */
export type AdvanceCursorPersist = (
  sourceKey: string,
  state: {
    observedTopUpdatedAt: string;
    observedIdsAtTopUpdatedAt: string[];
    deadLetteredIds: string[];
  }
) => unknown;

/**
 * ISS-5347: how the durable cursor persist for one advance actually resolved.
 *
 * The advance below is intentionally best-effort — a persist failure must never
 * throw through into the lane's drain — but "best effort" had meant "silently
 * discarded". A rejected persist, or a missing persist callback, left the
 * IN-MEMORY keyset advanced while the durable `sync_state` row stayed where it
 * was, with no log, no counter, and no state anywhere to notice it. On Mike's
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
   * completion needs to distinguish (wongk review).
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
  deadLetteredIds: string[];
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
 * the session lane's `MAX_DEAD_LETTERED_IDS`. Oldest entries are evicted first so
 * the Map cannot grow unbounded from a pathological run. Evicted ids are not
 * dropped from the cloud's perspective — they re-sync on their next change. */
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
 * many re-attempts have already failed, and whether it has been quarantined. */
type DeadLetterEntry = {
  retryAfterMs: number;
  attempts: number;
  quarantined: boolean;
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

  /**
   * Record a failed send for the batch read at `boundaryKey`, carrying the ids
   * that were in that batch. Returns `true` when the boundary has now failed
   * {@link COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD} times in a row and its ids
   * were moved to the dead-letter set (so the caller must advance the cursor
   * PAST this batch); `false` while the batch should keep retrying in place.
   */
  recordBatchFailure(
    boundaryKey: string,
    batchIds: readonly string[],
    nowMs: number
  ): boolean {
    const next = (this.boundaryFailures.get(boundaryKey) ?? 0) + 1;
    if (next < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD) {
      this.boundaryFailures.set(boundaryKey, next);
      return false;
    }
    // Threshold reached: dead-letter every id in the batch to the back of the
    // line and clear the boundary counter (the cursor is about to move past it).
    this.boundaryFailures.delete(boundaryKey);
    for (const id of batchIds) {
      this.enqueueDeadLetter(id, nowMs);
    }
    return true;
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
        this.deadLettered.delete(id);
        continue;
      }
      const entry = this.deadLettered.get(id);
      if (!entry) {
        continue;
      }
      entry.attempts += 1;
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

  /** Snapshot of the current dead-lettered ids, persisted onto the durable cursor
   * row (`PersistedSyncState.deadLetteredIds`) so a cold restart can re-drive them
   * even after the monotonic cursor has advanced past their `(ts, id)` position —
   * true never-drop across restarts, not just re-sync-on-change. */
  deadLetteredIds(): string[] {
    return [...this.deadLettered.keys()];
  }

  /** Re-seed the dead-letter set from a persisted snapshot on hydration (identity
   * change / first run). Each re-seeded id starts a FRESH first-attempt window
   * due immediately — a restart un-quarantines and re-drives a previously-parked
   * poison item once, which is harmless (it re-quarantines if it still fails) and
   * guarantees the item is never permanently stranded. Ignores ids already
   * tracked so a live snapshot never resets an in-flight backoff. */
  seedDeadLetters(ids: readonly string[], nowMs: number): void {
    for (const id of ids) {
      this.enqueueDeadLetter(id, nowMs);
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
    this.deadLettered.clear();
  }

  /** Move `id` into the dead-letter set with a fresh first-attempt window, or —
   * if already present — leave its escalating bookkeeping intact so re-batching
   * the same id does not reset its backoff. Evicts the oldest entry at the cap. */
  private enqueueDeadLetter(id: string, nowMs: number): void {
    if (this.deadLettered.has(id)) {
      return;
    }
    if (this.deadLettered.size >= COMPONENT_MAX_DEAD_LETTERED_IDS) {
      const oldest = this.deadLettered.keys().next().value;
      if (oldest !== undefined) {
        this.deadLettered.delete(oldest);
      }
    }
    this.deadLettered.set(id, {
      // First attempt is due immediately once the lane is drained: the initial
      // dead-letter is a deferral to the back of the line, not a delay.
      retryAfterMs: nowMs,
      attempts: 0,
      quarantined: false,
    });
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
 * ISS-4542 (shafty023 review): the CLASS of a component-sync send result, so the
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
 *                    timeout errors, HTTP 401/403/408/429, and any 5xx.
 * - `BatchRejected`— a PERMANENT per-batch rejection the server attributes to the
 *                    batch content itself (HTTP 409/413/422). Only THIS class
 *                    charges the boundary budget so a genuine poison batch is
 *                    dead-lettered to the back of the line.
 *
 * A bare 400 is deliberately NOT `BatchRejected`: `POST /desktop/components/sync`
 * returns a generic 400 for an invalid payload, and its schema pins an exact
 * `schemaVersion` literal, so a Desktop/API version skew makes EVERY page 400.
 * Dead-lettering on that would walk the whole inventory forward and strand it on
 * one side of the skew (shafty023 review) — the cross-repo compatibility contract
 * requires version skew to pause and heal, not drop rows. An unqualified 400 is
 * therefore classified conservatively as `LaneFailure`.
 */
export const ComponentSyncSendOutcome = {
  Accepted: "accepted",
  LaneFailure: "lane-failure",
  BatchRejected: "batch-rejected",
} as const;
export type ComponentSyncSendOutcome =
  (typeof ComponentSyncSendOutcome)[keyof typeof ComponentSyncSendOutcome];

/** Non-auth 4xx statuses that name a PERMANENT problem with the batch body/target
 * mapping itself (conflict, payload too large, unprocessable) rather than a
 * transient or lane-wide condition. Only these charge the poison budget. A bare
 * 400 is intentionally excluded — the sync endpoint returns generic 400 for a
 * version-skew `schemaVersion` mismatch that affects every page, so it is treated
 * as a lane-wide `LaneFailure` (shafty023 review). */
const BATCH_REJECTED_STATUSES = new Set<number>([409, 413, 422]);

/**
 * Classify an HTTP status from `POST /desktop/components/sync` into a send
 * outcome. A 2xx is `Accepted`. A permanent per-batch 4xx (see
 * {@link BATCH_REJECTED_STATUSES}) is `BatchRejected` — the only class that
 * charges the boundary budget toward dead-lettering. Everything else — auth
 * (401/403), request timeout (408), rate limit (429), and every 5xx — is a
 * `LaneFailure` that pauses the lane without advancing or charging the budget.
 */
export function classifyComponentSyncHttpStatus(
  status: number
): ComponentSyncSendOutcome {
  if (status >= 200 && status < 300) {
    return ComponentSyncSendOutcome.Accepted;
  }
  if (BATCH_REJECTED_STATUSES.has(status)) {
    return ComponentSyncSendOutcome.BatchRejected;
  }
  // 400 (unqualified bad request — includes version-skew schemaVersion mismatch),
  // 401/403 (auth/policy), 408 (timeout), 429 (rate limit), 5xx (server), and any
  // other unclassified status: lane-wide, pause without charging the poison budget.
  return ComponentSyncSendOutcome.LaneFailure;
}

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
};

/** Dependencies for {@link handleComponentSendFailure}. */
export type ComponentSendFailureDeps = {
  tracker: ComponentSyncDeadLetterTracker;
  /** The keyset boundary the failing batch was read from. */
  boundaryKey: string;
  /** The component ids in the failing batch (dead-lettered on threshold). */
  batchIds: readonly string[];
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
  const { tracker, boundaryKey, batchIds, componentCount, canAdvance, diag } =
    deps;
  const deadLettered = tracker.recordBatchFailure(
    boundaryKey,
    batchIds,
    Date.now()
  );
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
  /** ISS-4542 (wongk review): supersession guard. Returns `false` once the lane's
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
    // ISS-4542 (wongk review): an empty load is AMBIGUOUS. `app.ts`'s
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
  // ISS-4623 (shafty023 review): re-check freshness IMMEDIATELY before the
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
  // ISS-4542 (wongk review): the recovery send await may have resolved AFTER a
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
    // ISS-4542 (shafty023 review): a lane-wide failure during recovery (auth /
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
  deadLetteredIds: string[],
  onPersistOutcome?: ComponentCursorPersistObserver
): ComponentSyncCursorPosition {
  const watermark = lastRow.last_seen_at ?? "";
  const lastId = lastRow.id;
  const advanced = watermark !== current.watermark || lastId !== current.lastId;
  if (advanced) {
    persistComponentCursorPosition(
      persist,
      sourceKey,
      // ISS-4542: persist the component lane's dead-lettered ids onto the
      // durable cursor row so a cold restart re-drives them even after the
      // cursor has advanced past their (ts, id) position.
      { watermark, lastId, deadLetteredIds },
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
 * Split out of {@link advanceComponentCursor} (wongk review) because the advance
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
  Promise.resolve(
    persist(sourceKey, {
      observedTopUpdatedAt: position.watermark,
      observedIdsAtTopUpdatedAt: [position.lastId],
      deadLetteredIds: position.deadLetteredIds,
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
 * Hand one persist outcome to the optional observer without ever letting the
 * observer's own throw escape (thadeusb review).
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
