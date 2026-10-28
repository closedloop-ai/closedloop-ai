/**
 * @file agent-session-sync-cursor-persist.ts
 * @description WHEN the session lane's durable `sync_state` cursor is written,
 * and what it claims when it is. Extracted out of the grandfathered
 * `agent-session-sync-service.ts` by ISS-8041, which had to change every member
 * of this cluster at once: the two write paths, the snapshot they share, and the
 * outbox seed that orders one of them. Its twin `agent-session-sync-cursor-prefix`
 * owns WHERE the watermark may sit; this module owns the writes and the one piece
 * of state that spans them.
 *
 * THE STATE THAT SPANS THEM is `lastPersistedTopUpdatedAt` — the position this
 * lane last wrote for the current identity. It lives in this closure rather than
 * on the service because only these writes may set it and only the boundary
 * resolver reads it, and because getting it wrong is silent: FEA-3473's initial
 * persist deliberately records the corpus MAXIMUM while the backfill queue is
 * still full (the outbox is the complete ledger by then), so a prefix boundary
 * recomputed during that walk sits far below it. Publishing what was written is
 * what makes the resolver refuse to rewind the cursor there.
 *
 * A REJECTED WRITE ROLLS THAT POSITION BACK. Both writes are best-effort — a
 * failed cursor write only means the next cold start re-walks — but the
 * never-move-backwards refusal reads this value, so leaving it claiming a
 * position the disk never took would suppress the retry of the lane's own lost
 * write. Only `persistIfAdvanced` needs the rollback, because it is the one that
 * claims the position BEFORE the write (it has to: the write is fire-and-forget,
 * and a concurrent second call would otherwise re-claim the same boundary). The
 * rollback is conditional on the value still being the one this call set, so a
 * later successful write is never clobbered by an earlier rejection.
 *
 * AND NEITHER IS PUBLISHED ACROSS AN IDENTITY SWITCH. Every write here spans an
 * await, and an account or compute-target flip inside that window would
 * otherwise stamp the NEXT identity's tracker with a position it never wrote —
 * which reads as "the disk is already ahead of you" and refuses that identity's
 * boundaries until it climbs past a watermark belonging to somebody else. So a
 * generation counter, bumped by `reset`, is captured before each await and
 * re-checked before anything is published:
 *
 *  - `seedThenPersistInitialBackfill` captures it before the SEED, not before
 *    the cursor write, because a flip during the seed leaves the whole
 *    subsequent read describing a different corpus.
 *  - `persistIfAdvanced`'s rollback checks it too. Comparing the VALUE alone is
 *    not enough there: two identities can compute the same boundary string, and
 *    a rejection would then restore the previous identity's position into the
 *    current one's tracker.
 *
 * The writes themselves are unaffected either way — each is addressed by the
 * `sourceKey` it was called with, never by the live one.
 *
 * EVERY WRITE DISPATCHES AS A MEMBER EXPRESSION. The production source is the
 * DB-host method proxy, whose `get` trap answers `call`/`bind`/`apply` with
 * `undefined` on purpose — detaching one used to build the op path
 * `<op>.bind`, post the un-cloneable proxy over IPC, and take the process down
 * through the unhandled-rejection handler. That shipped twice, once as
 * `syncSource.advanceSyncState.bind` (ISS-4620). So `source.advanceSyncState(…)`,
 * never a hoisted local invoked with `.call`, and the guard reads the property
 * for truthiness rather than detaching it.
 */
import type { AgentSessionSyncClass } from "./agent-session-sync-contract.js";
import {
  type CursorPrefixBoundary,
  resolveCursorPrefixBoundary,
  resolveOldestOwedUpdatedAt,
  type SessionCursorBoundary,
} from "./agent-session-sync-cursor-prefix.js";
import { buildPersistedCursorState } from "./agent-session-sync-service-helpers.js";
import type {
  AgentSessionOutboxEntry,
  AgentSessionSyncSource,
  PersistedSyncState,
  SyncContractCapabilities,
} from "./agent-session-sync-source.js";

/**
 * The lane state one cursor write reads. Re-resolved per CALL, never captured:
 * the identity, the queues and the watermark all move under this collaborator,
 * and a write bound to a stale identity would land on another account's
 * partition (the discipline `createOutboxWriters` established).
 */
export type SessionCursorPersistState = {
  /** False while the historical backfill is deferred; no watermark is recorded then. */
  historicalBackfillEnabled: boolean;
  /** The hydrated identity, or null when there is none to write under. */
  sourceKey: string | null;
  source: AgentSessionSyncSource | null;
  /**
   * ISS-5850 / ISS-7896: what the connected server proved it can STORE, passed
   * to the write so both sides resolve the same payload-contract revision.
   */
  contract?: SyncContractCapabilities;
  /** Every id a lane still owes, MATERIALIZED — see `CursorPrefixInput.unackedIds`. */
  unackedIds: readonly string[];
  queuedUpdatedAtById: ReadonlyMap<string, string>;
  observedTopUpdatedAt: string | null;
  observedIdsAtTopUpdatedAt: ReadonlySet<string>;
  /** Recorded in the cursor so abandoned rows are remembered, not re-walked. */
  deadLetteredIds: Iterable<string>;
};

/** The durable-cursor writes the session lane performs, bound to one live state getter. */
export type SessionCursorPersister = {
  /**
   * Record the acked-contiguous prefix boundary, if there is one this lane may
   * claim. Fire-and-forget; a no-op when the resolver refuses.
   */
  persistIfAdvanced(): void;
  /**
   * FEA-3473: durably seed the outbox for the initial full-corpus walk, then —
   * and ONLY then — record the corpus maximum, without a prefix boundary.
   *
   * The ordering IS the anti-stranding invariant, which is why these are one
   * call and not two. The seed is AWAITED, unlike the fire-and-forget
   * `recordOutboxEnqueue`, because the cursor may skip the next start's full
   * re-walk only once the outbox is a complete ledger of remaining work
   * (acked→deleted, dead→marked, pending→remaining); a crash mid-seed leaves the
   * cursor unpersisted and the safe re-walk runs. Splitting them let the
   * identity flip inside the seed's await and the persist then read the NEXT
   * identity's watermark while writing under the previous one's key.
   *
   * A no-op on an absent delegate, a rejected seed, or an identity change during
   * it. Warn-logged on throw; never rejects.
   *
   * ISS-8116: `isCurrentIdentity` is the CALLING PASS's own identity predicate,
   * checked alongside the generation counter before the cursor write. The
   * counter only moves when something calls `reset` — a `stop()` or a
   * hydration-time identity clear — so it cannot see a bare compute-target or
   * account flip that no pass has observed yet. Optional because the generation
   * check is the floor; supplying it only ever refuses more.
   */
  seedThenPersistInitialBackfill(
    sourceKey: string,
    ids: string[],
    isCurrentIdentity?: () => boolean
  ): Promise<void>;
  /**
   * ISS-10429: the row the watermark is waiting on, for the burn-down's
   * cursor-stall detector.
   *
   * `null` when this lane records no cursor right now ({@link canWriteCursor})
   * and when no owed row can be named — nothing is owed, or an owed id has no
   * live-scan stamp. Both read as "unknown", and the detector never suppresses
   * on unknown.
   *
   * It does NOT mirror {@link persistIfAdvanced}'s fourth refusal, before the
   * first scan has produced a watermark: that window is inside the initial walk
   * (`seedObservedTop` and the backfill enqueue run in the same pass), and a
   * lane doing work there has never persisted a cursor, which
   * `classifyCursorStall` reports on its own branch.
   */
  readBoundary(): SessionCursorBoundary | null;
  /** Adopt the position a hydrated `sync_state` row proves is already on disk. */
  noteResumedFrom(observedTopUpdatedAt: string): void;
  /** Identity change or hard reset: nothing on disk belongs to the next one. */
  reset(): void;
};

/**
 * Bind every durable-cursor write above to one live state getter and the single
 * `lastPersistedTopUpdatedAt` they share. `warn` is the lane's own log seam, so
 * this module reaches nothing beyond the state it is handed.
 */
export function createSessionCursorPersister(
  readState: () => SessionCursorPersistState,
  warn: (message: string) => void,
  backfillSyncClass: AgentSessionSyncClass
): SessionCursorPersister {
  let lastPersistedTopUpdatedAt: string | null = null;
  // Bumped by every `reset`, so each write that touches the tracker across an
  // await can tell whether the identity it belongs to is still the live one.
  let identityGeneration = 0;
  return {
    persistIfAdvanced() {
      const state = readState();
      const { source, sourceKey } = state;
      if (!(canWriteCursor(state) && sourceKey && source?.advanceSyncState)) {
        return;
      }
      const boundary = resolveCursorPrefixBoundary({
        unackedIds: state.unackedIds,
        queuedUpdatedAtById: state.queuedUpdatedAtById,
        observedTopUpdatedAt: state.observedTopUpdatedAt,
        observedIdsAtTopUpdatedAt: state.observedIdsAtTopUpdatedAt,
        lastPersistedTopUpdatedAt,
      });
      if (boundary === null) {
        return;
      }
      const rollbackTo = lastPersistedTopUpdatedAt;
      const generation = identityGeneration;
      lastPersistedTopUpdatedAt = boundary.observedTopUpdatedAt;
      // Roll back only what THIS write claimed, for the identity it claimed it
      // under. The value test alone is not enough: two identities can compute
      // the same boundary string, and restoring the previous one's position
      // into the current one's tracker would refuse writes it never made.
      const rollback = (error: unknown) => {
        if (
          generation === identityGeneration &&
          lastPersistedTopUpdatedAt === boundary.observedTopUpdatedAt
        ) {
          lastPersistedTopUpdatedAt = rollbackTo;
        }
        warn(`failed to persist agent-session sync cursor: ${reason(error)}`);
      };
      // BOTH failure modes reach that rollback. `advanceSyncState` is declared
      // `void | Promise<void>`, so a synchronous implementation is in-contract,
      // and the production source is the DB-host method proxy whose `apply` can
      // throw before any promise exists. As the argument to `Promise.resolve`
      // the call is evaluated EAGERLY, so a synchronous throw would escape with
      // no `.catch` attached and the tracker already advanced — leaving the
      // never-move-backwards refusal to drop every later write until restart.
      try {
        Promise.resolve(
          source.advanceSyncState(
            sourceKey,
            snapshot(state.deadLetteredIds, boundary, warn),
            state.contract
          )
        ).catch(rollback);
      } catch (error) {
        rollback(error);
      }
    },
    async seedThenPersistInitialBackfill(sourceKey, ids, isCurrentIdentity) {
      const generation = identityGeneration;
      if (
        !(await seedOutbox(
          readState(),
          sourceKey,
          ids,
          backfillSyncClass,
          warn
        ))
      ) {
        return;
      }
      // The identity changed while the seed was in flight. The seed itself
      // landed under `sourceKey` and is correct; the watermark is not ours to
      // write, because the state below now describes somebody else's corpus.
      // ISS-8116: the caller's predicate is the second half of that question —
      // the counter answers "did something reset this lane", the predicate
      // answers "is the LIVE key still the one this pass captured".
      if (generation !== identityGeneration) {
        return;
      }
      if (isCurrentIdentity && !isCurrentIdentity()) {
        return;
      }
      const state = readState();
      const { source } = state;
      const observedTopUpdatedAt = state.observedTopUpdatedAt;
      if (!(source?.advanceSyncState && observedTopUpdatedAt)) {
        return;
      }
      try {
        await source.advanceSyncState(
          sourceKey,
          snapshot(
            state.deadLetteredIds,
            {
              observedTopUpdatedAt,
              observedIdsAtTopUpdatedAt: state.observedIdsAtTopUpdatedAt,
            },
            warn
          ),
          state.contract
        );
        if (generation === identityGeneration) {
          lastPersistedTopUpdatedAt = observedTopUpdatedAt;
        }
      } catch (error) {
        warn(`failed to persist initial backfill cursor: ${reason(error)}`);
      }
    },
    readBoundary() {
      const state = readState();
      if (!(canWriteCursor(state) && state.sourceKey)) {
        return null;
      }
      const value = resolveOldestOwedUpdatedAt(state);
      return value === null ? null : { sourceKey: state.sourceKey, value };
    },
    noteResumedFrom(observedTopUpdatedAt) {
      lastPersistedTopUpdatedAt = observedTopUpdatedAt;
    },
    reset() {
      lastPersistedTopUpdatedAt = null;
      identityGeneration += 1;
    },
  };
}

/**
 * Append the `pending` outbox rows for the initial full-corpus walk. `true` only
 * when the write COMMITTED — a false is either "there was no durable ledger to
 * write to" or "the write failed", and both mean the cursor may not be recorded.
 */
async function seedOutbox(
  state: SessionCursorPersistState,
  sourceKey: string,
  ids: readonly string[],
  syncClass: AgentSessionSyncClass,
  warn: (message: string) => void
): Promise<boolean> {
  const { source } = state;
  if (ids.length === 0 || !source?.enqueueOutboxEntries) {
    return false;
  }
  const entries: AgentSessionOutboxEntry[] = ids.map((externalSessionId) => ({
    externalSessionId,
    syncClass,
  }));
  try {
    await source.enqueueOutboxEntries(sourceKey, entries);
    return true;
  } catch (error) {
    warn(
      `failed to record ${entries.length} outbox enqueue(s): ${reason(error)}`
    );
    return false;
  }
}

/** The durable cursor snapshot; the shape and its tied-top cap live in the helpers. */
function snapshot(
  deadLetteredIds: Iterable<string>,
  boundary: CursorPrefixBoundary,
  warn: (message: string) => void
): PersistedSyncState {
  return buildPersistedCursorState(
    {
      observedTopUpdatedAt: boundary.observedTopUpdatedAt,
      observedIdsAtTopUpdatedAt: boundary.observedIdsAtTopUpdatedAt,
      deadLetteredIds,
    },
    warn
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether this lane records a cursor at all right now. {@link
 * SessionCursorPersister.readBoundary} shares it with `persistIfAdvanced`, so
 * the detector never names a boundary the lane would not write.
 */
function canWriteCursor(state: SessionCursorPersistState): boolean {
  return (
    state.historicalBackfillEnabled &&
    Boolean(state.sourceKey) &&
    Boolean(state.source?.advanceSyncState)
  );
}
