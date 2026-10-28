/**
 * @file agent-session-sync-stale-continuation.test.ts
 * @description ISS-6031 (codex review): the two ISS-6031 continuations that
 * survive an `await` must not write service state for a superseded generation.
 *
 * Both awaits added by ISS-6031 — the presence probe behind
 * `resolveEmptyHydration`, and the fire-and-forget outbox read behind
 * `reconcilePendingOutbox` — resolve into deps that write the LIVE service:
 * queues, `nextRetryAfterMs`, `deadLetteredIds`, and the durable outbox. If
 * `stop()`, an account switch, or a compute-target change lands while one is
 * outstanding, `resetSourceState()` has already cleared that state
 * synchronously, so an unguarded continuation repopulates it for the PREVIOUS
 * target and issues its outbox write against the NEW one — i.e. sessions
 * selected under one account uploading under another.
 *
 * These drive the REAL `AgentSessionSyncService` and reset it MID-FLIGHT, with a
 * deferred source so the interleaving is deterministic rather than timed. Each
 * assertion is on state the unguarded code demonstrably produces: dropping
 * either `isCurrentSourceState` guard fails these (verified by reverting them —
 * see the PR test plan), while every happy-path suite stays green, because the
 * guards are reached only after a reset.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { flushAgentSessionSync } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TARGET_A = "target-iss-6031-account-a";
const TARGET_B = "target-iss-6031-account-b";
const SOURCE_KEY_A = buildAgentSessionSyncSourceKey(TARGET_A);
const SESSION_ID = "session-selected-under-account-a";
const UPDATED_AT = "2026-08-12T03:29:06.102Z";
/** ISS-6067: never-synced, and reachable only by a full walk under account B. */
const SESSION_UNDER_B = "session-present-only-under-account-b";
/** A row account A abandoned; its persisted cursor carries it. */
const DEAD_UNDER_A = "session-dead-lettered-under-account-a";
/** Account A's watermark, deliberately ABOVE {@link UPDATED_AT}. */
const CURSOR_AT_A = "2026-08-12T05:00:00.000Z";

/** A promise plus the handle to settle it from the test body. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A source whose local-presence probe hangs until the test releases it, so the
 * reset can be interleaved exactly between the probe call and its resolution.
 * The session is genuinely gone from the store, so the released continuation
 * takes the CONFIRMED-ABSENT branch — the one that dead-letters and writes the
 * outbox, and therefore the one whose leakage is unambiguous.
 */
class DeferredProbeSource extends FakeSyncSource {
  readonly probeCalled = deferred<void>();
  readonly releaseProbe = deferred<string[]>();

  override findExistingSessionIds(ids: string[]): string[] | Promise<string[]> {
    this.findExistingSessionIdCalls.push(ids);
    this.probeCalled.resolve();
    return this.releaseProbe.promise;
  }
}

/**
 * Same shape for the IDLE-TICK outbox reconciliation read.
 *
 * The first `loadPendingOutboxIds` of a run is the FEA-3473 resume re-enqueue
 * inside `hydratePersistedCursorIfNeeded`, which is a different (awaited, not
 * fire-and-forget) call site with its own pre-existing behavior — so it is
 * answered synchronously and only the later, reconciliation reads are deferred.
 * Without that split the test would assert against the resume path and prove
 * nothing about the continuation under review.
 */
class DeferredOutboxSource extends FakeSyncSource {
  readonly readCalled = deferred<void>();
  readonly releaseRead = deferred<string[]>();
  outboxReadCount = 0;

  override loadPendingOutboxIds(
    sourceKey: string
  ): string[] | Promise<string[]> {
    this.outboxReadCount += 1;
    if (this.outboxReadCount === 1) {
      return this.pendingOutboxIds(sourceKey);
    }
    this.readCalled.resolve();
    return this.releaseRead.promise;
  }
}

/**
 * ISS-6067: the RESUME path's outbox read — the FIRST `loadPendingOutboxIds` of a
 * run, inside `hydratePersistedCursorIfNeeded`. This is the call site ISS-6031
 * deliberately left unguarded, and the one {@link DeferredOutboxSource} above
 * answers synchronously so its own cases could not reach it. Here it is the
 * subject, so the FIRST call is the deferred one.
 *
 * Later reads answer EMPTY rather than re-reading the durable rows, which is
 * what makes the queue-depth assertions below discriminate this guard. The
 * ISS-6031 idle-tick reconciliation reads the same outbox and legitimately
 * re-queues a still-owed row while the identity is unchanged — so with a live
 * re-read, a queue depth of 1 is produced by that correct path just as readily
 * as by a bypassed resume guard, and the assertion decides on whichever pass
 * ran first instead of on the behavior under test. Answering empty leaves the
 * resume read as the only way the id can reach a lane. The reconciliation's own
 * recovery is ISS-6031's contract and is covered by its cases above.
 */
class DeferredResumeOutboxSource extends FakeSyncSource {
  readonly readCalled = deferred<void>();
  readonly releaseRead = deferred<string[]>();
  outboxReadCount = 0;

  override loadPendingOutboxIds(
    _sourceKey: string
  ): string[] | Promise<string[]> {
    this.outboxReadCount += 1;
    if (this.outboxReadCount > 1) {
      return [];
    }
    this.readCalled.resolve();
    return this.releaseRead.promise;
  }
}

/**
 * ISS-6067: same deferred first read, but later reads answer TRUTHFULLY, so the
 * test can observe whether the resume read happens AGAIN after a discard. Used
 * only by the reconnect case, which closes the idle-reconcile gate
 * (`historicalBackfill: false`) so the resume path is the sole outbox reader and
 * a second read cannot come from anywhere else.
 */
class ReconnectingResumeOutboxSource extends FakeSyncSource {
  readonly readCalled = deferred<void>();
  readonly releaseRead = deferred<string[]>();
  outboxReadCount = 0;

  override loadPendingOutboxIds(
    sourceKey: string
  ): string[] | Promise<string[]> {
    this.outboxReadCount += 1;
    if (this.outboxReadCount > 1) {
      return this.pendingOutboxIds(sourceKey);
    }
    this.readCalled.resolve();
    return this.releaseRead.promise;
  }
}

function makeService(
  getSource: () => FakeSyncSource,
  getComputeTargetId: () => string,
  onBatch: (ids: string[]) => void,
  isHttpReady: () => boolean = () => true
): AgentSessionSyncService {
  return new AgentSessionSyncService({
    isHttpReady,
    getSource,
    getSyncComputeTargetId: getComputeTargetId,
    sendBatch: (batch) => {
      onBatch(batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({ accepted: true as const });
    },
  });
}

/** A session that is enqueued and owed, but whose row no longer hydrates. */
function owedSession(): SyncedAgentSession {
  return makeSyncedSession(SESSION_ID, UPDATED_AT);
}

test("ISS-6031: a presence probe that resolves after stop() disposes of nothing", async () => {
  gatewayLog.clear();
  const source = new DeferredProbeSource([owedSession()]);
  source.seedOutbox(SOURCE_KEY_A, SESSION_ID);
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  // A real delete-after-enqueue: the row is gone from `sessions`, so once the
  // probe answers, the CONFIRMED-ABSENT branch would dead-letter and write the
  // outbox — if it were still allowed to.
  source.deleteSession(SESSION_ID);
  await source.probeCalled.promise;

  // The reset lands while the probe is outstanding. `resetSourceState()` has now
  // cleared `deadLetteredIds` and the queues synchronously.
  service.stop();
  source.releaseProbe.resolve([]);
  await flushAgentSessionSync();
  await flushAgentSessionSync();

  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "a superseded probe must not repopulate the dead-letter set a reset just cleared"
  );
  const row = [...source.outbox.values()].find(
    (entry) => entry.sourceKey === SOURCE_KEY_A && entry.id === SESSION_ID
  );
  assert.equal(
    row?.status,
    "pending",
    "and must not flip the durable outbox row of the previous generation"
  );
  assert.deepEqual(sent, [], "nothing is sent after stop()");
});

test("ISS-6031: an outbox read that resolves after a target switch queues nothing from the old account", async () => {
  gatewayLog.clear();
  // Empty store: the backfill enumerates nothing, so both queues drain on the
  // first tick and the lane reaches the IDLE state the reconciliation runs in.
  const source = new DeferredOutboxSource([]);
  let computeTargetId = TARGET_A;
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => computeTargetId,
    (ids) => sent.push(ids)
  );

  service.start();
  await flushAgentSessionSync();
  // Owed under account A, tracked by neither queue — the exact shape the
  // idle-tick reconciliation exists to re-select, and it appears AFTER resume so
  // only the reconciliation can see it.
  source.seedOutbox(SOURCE_KEY_A, SESSION_ID);
  service.refresh();
  await source.readCalled.promise;

  // The account/compute-target switch: a new identity, and the queue/cursor
  // state derived from the old one dropped.
  computeTargetId = TARGET_B;
  service.resetSourceState();
  source.releaseRead.resolve([SESSION_ID]);
  await flushAgentSessionSync();
  await flushAgentSessionSync();

  const progress = service.getSyncProgress();
  assert.equal(
    progress.pendingBackfillSessions,
    0,
    "ids read under account A must not be fed onto account B's backfill lane"
  );
  assert.equal(
    progress.pendingIncrementalSessions,
    0,
    "nor onto its incremental lane"
  );
  assert.ok(
    !sent.flat().includes(SESSION_ID),
    "and therefore can never upload under the wrong account"
  );
  service.stop();
});

test("ISS-6031: an outbox read that resolves after stop() queues nothing", async () => {
  gatewayLog.clear();
  const source = new DeferredOutboxSource([]);
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  await flushAgentSessionSync();
  source.seedOutbox(SOURCE_KEY_A, SESSION_ID);
  service.refresh();
  await source.readCalled.promise;
  service.stop();
  source.releaseRead.resolve([SESSION_ID]);
  await flushAgentSessionSync();
  await flushAgentSessionSync();

  assert.equal(
    service.getSyncProgress().pendingBackfillSessions,
    0,
    "a stopped service must not resurrect a queue the stop just cleared"
  );
  assert.deepEqual(sent, [], "and must not send after stop()");
});

/**
 * ISS-6067, GENERATION half. `stop()` bumps the source-state generation and
 * invalidates the pass token, but leaves the LIVE source key exactly where it
 * was — so the source-key half cannot see this one, and only the pass guard
 * catches it.
 *
 * The assertion is taken AFTER the stop deliberately. The queue this path
 * repopulates SURVIVES a `stop()`: the next hydration calls
 * `clearSourceDerivedState()` only when it had a previously hydrated identity,
 * and the stop nulled that — so an unguarded re-enqueue is not cleaned up later,
 * it simply waits for whatever identity resumes next.
 */
test("ISS-6067: a resume outbox read that resolves after stop() queues nothing", async () => {
  gatewayLog.clear();
  const source = new DeferredResumeOutboxSource([]);
  // Owed under account A from a previous run: the durable row the resume
  // re-enqueue exists to recover.
  source.seedOutbox(SOURCE_KEY_A, SESSION_ID);
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  // The sign-out lands while the resume read is outstanding. `resetSourceState()`
  // has now cleared the queues and nulled the hydrated identity synchronously.
  service.stop();
  source.releaseRead.resolve([SESSION_ID]);
  // whitlockk (PR #5920): the pass's OWN completion signal. A fixed number of
  // microtask flushes is not a completion barrier — it can expire mid-pass and
  // let these assertions read state the discarded continuation has not reached
  // yet, which passes for a reason that has nothing to do with the guard.
  await service.whenSessionSyncSettled();

  assert.equal(
    service.getSyncProgress().pendingBackfillSessions,
    0,
    "a superseded resume read must not repopulate the backfill queue the stop just cleared"
  );
  assert.deepEqual(sent, [], "nothing is sent after stop()");
});

/**
 * ISS-6067, SOURCE-KEY half. A bare compute-target switch changes the identity
 * WITHOUT bumping the source-state generation and without invalidating the pass
 * token — nothing resets on a target flip alone. The pass guard therefore still
 * reports "current" here, and only comparing the live source key against the one
 * the ids were read under catches it.
 *
 * This is the wrong-account failure the ticket names, and the same one
 * `injectIdsIntoLiveQueue` already refuses on the live-inject path: ids selected
 * under the previous target must not enter the newly-resolved target's lane and
 * settle there while the previous target's durable row stays owed.
 *
 * The store is EMPTY, so an id that leaks onto the live lane is disposed of by
 * the drain rather than sitting on it — which is why the queue counters alone
 * would pass for the wrong reason. The surviving evidence is the disposal: the
 * confirmed-absent branch dead-letters the leaked id and flips its durable row.
 * Both are asserted below.
 */
test("ISS-6067: a resume outbox read that resolves after a target switch queues nothing from the old account", async () => {
  gatewayLog.clear();
  // Empty store so nothing but the resume re-enqueue can populate a queue.
  const source = new DeferredResumeOutboxSource([]);
  source.seedOutbox(SOURCE_KEY_A, SESSION_ID);
  let computeTargetId = TARGET_A;
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => computeTargetId,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  // The account switch, with NO reset: the generation and the pass token are
  // both untouched, which is exactly what makes this the case the generation
  // half alone lets through.
  computeTargetId = TARGET_B;
  source.releaseRead.resolve([SESSION_ID]);
  await service.whenSessionSyncSettled();

  const progress = service.getSyncProgress();
  assert.equal(
    progress.pendingBackfillSessions,
    0,
    "ids read under account A must not be fed onto account B's backfill lane"
  );
  assert.equal(
    progress.pendingIncrementalSessions,
    0,
    "nor onto its incremental lane"
  );
  assert.equal(
    progress.deadLetteredSessions,
    0,
    "an id that leaks onto account B's lane is disposed of there \u2014 nothing read under account A may reach a disposition under B"
  );
  const row = [...source.outbox.values()].find(
    (entry) => entry.sourceKey === SOURCE_KEY_A && entry.id === SESSION_ID
  );
  assert.equal(
    row?.status,
    OutboxStatus.Pending,
    "and account A's durable row stays owed rather than being settled by account B's lane"
  );
  assert.ok(
    !sent.flat().includes(SESSION_ID),
    "and therefore can never upload under the wrong account"
  );
  service.stop();
});

/**
 * ISS-6067, BOTH-CURRENT half — the guard's allow path, and the reason the two
 * refusals above are not vacuous.
 *
 * Same fixture and same evidence as the target-switch case, with the ONE
 * difference the guard reads: nothing supersedes the source state while the
 * resume read is outstanding. No `stop()`, no target flip, so the generation,
 * the pass token, and the live source key are all still the ones the ids were
 * read under, and the re-enqueue must go through.
 *
 * The store is empty here for the same reason it is empty above: a seeded store
 * would let the backfill enumeration queue the session on its own, and the
 * assertion could then pass without the resume read contributing anything. With
 * an empty store the resume re-enqueue is the only route onto a lane, so the
 * disposal it ends in is proof the ids arrived — the confirmed-absent branch
 * dead-letters the id and settles account A's durable row, which is exactly the
 * pair the refusals above require to stay untouched.
 */
test("ISS-6067: a resume outbox read that resolves while the source state is unchanged re-enqueues", async () => {
  gatewayLog.clear();
  const source = new DeferredResumeOutboxSource([]);
  source.seedOutbox(SOURCE_KEY_A, SESSION_ID);
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  source.releaseRead.resolve([SESSION_ID]);
  await service.whenSessionSyncSettled();

  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "an unsuperseded resume read must feed its ids onto the lane, where the empty store disposes of them"
  );
  const row = [...source.outbox.values()].find(
    (entry) => entry.sourceKey === SOURCE_KEY_A && entry.id === SESSION_ID
  );
  assert.notEqual(
    row?.status,
    OutboxStatus.Pending,
    "and account A's durable row is settled by account A's own lane rather than left owed"
  );
  service.stop();
});

/**
 * ISS-6067, RE-ARM. A discard is only safe because the identity is left
 * un-hydrated so a later pass reads the outbox again — and the case that proves
 * it is a DROPPED SOCKET, not a reset: `isCurrentSourceState` closes over
 * `shouldRun()`, so it goes false while the identity is untouched and nothing
 * clears `hydratedSourceKey`. The resume read runs at most once per identity, so
 * without the re-arm the un-acked prefix is stranded for the life of the process.
 *
 * `historicalBackfill: false` is the configuration that makes the stranding
 * permanent rather than merely slow — it closes the `reconcilePendingOutboxIfIdle`
 * gate, which is the only other lane that would have re-discovered these rows.
 * It also makes the assertion honest: with that gate shut and an empty store, the
 * resume path is the ONLY thing that can read the outbox or reach a lane, so a
 * second read cannot be manufactured by another path.
 */
test("ISS-6067: a resume outbox read discarded on a dropped socket is re-read after reconnect", async () => {
  gatewayLog.clear();
  const source = new ReconnectingResumeOutboxSource([]);
  source.seedOutbox(SOURCE_KEY_A, SESSION_ID);
  let httpReady = true;
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => TARGET_A,
    (ids) => sent.push(ids),
    () => httpReady
  );

  service.start({ historicalBackfill: false });
  await source.readCalled.promise;
  // The socket drops while the resume read is outstanding. No stop(), no
  // identity change — so only `shouldRun()` flips, and nothing nulls
  // `hydratedSourceKey` on its own.
  httpReady = false;
  source.releaseRead.resolve([SESSION_ID]);
  await service.whenSessionSyncSettled();
  assert.equal(
    source.outboxReadCount,
    1,
    "sanity: while the socket is down no further pass reads the outbox"
  );

  // Reconnect. `refresh()` is what the real transport-readiness subscription
  // calls when the gate re-opens; without it the next pass waits on the poll
  // interval, which this suite does not drive.
  httpReady = true;
  service.refresh();
  await service.whenSessionSyncSettled();

  assert.ok(
    source.outboxReadCount >= 2,
    "the discarded resume read must be retried once the socket returns, not skipped for the life of the process"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "and the re-read ids must actually reach a lane"
  );
  service.stop();
});

/**
 * ISS-6067, CROSS-TARGET STATE (codex review, PR #5920). Un-hydrating on a
 * discard re-arms the resume read, but the pass that was discarded had ALREADY
 * seeded the old target's cursor and dead-letters into memory. Whether the next
 * identity clears them was keyed on `hydratedSourceKey`, which the discard just
 * nulled — so the next pass read that null as "nothing to clear" and account B
 * inherited account A's watermark and abandoned rows.
 *
 * The leak is asserted through its consequence rather than through a marker.
 * `initializeBackfillQueueIfNeeded` returns early whenever `observedTopUpdatedAt`
 * is set, so A's surviving watermark makes B skip the corpus walk entirely — and
 * because {@link SESSION_UNDER_B} sits BELOW that watermark, the incremental scan
 * cannot reach it either. A session present in the local store is then never
 * uploaded under the account that owns it, for the life of the process.
 */
test("ISS-6067: a discarded resume read must not hand the old target's derived state to the next one", async () => {
  gatewayLog.clear();
  // Present locally, never synced: only a full walk under B can reach it.
  const source = new DeferredResumeOutboxSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  // Account A's persisted state, seeded into memory by A's own hydration before
  // its resume read is discarded.
  source.seedSyncState(SOURCE_KEY_A, {
    observedTopUpdatedAt: CURSOR_AT_A,
    observedIdsAtTopUpdatedAt: [DEAD_UNDER_A],
    deadLetteredIds: [DEAD_UNDER_A],
  });
  let computeTargetId = TARGET_A;
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => computeTargetId,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  // The account switch lands while A's resume read is outstanding: the read is
  // discarded and the identity left un-hydrated, with A's cursor and
  // dead-letters already in memory.
  computeTargetId = TARGET_B;
  source.releaseRead.resolve([]);
  await service.whenSessionSyncSettled();

  // Account B's first pass — the one that must start from a clean slate.
  service.refresh();
  await service.whenSessionSyncSettled();

  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "account A's abandoned rows must not be carried into account B's dead-letter set"
  );
  assert.ok(
    sent.flat().includes(SESSION_UNDER_B),
    "and account B must walk its own corpus rather than resume from account A's watermark"
  );
  service.stop();
});

/**
 * ISS-6067 / ISS-7988, THE REST OF THE DISCARDED PASS (PR #5995 review).
 *
 * The cross-target case above asserts the state the NEXT pass sees. It cannot
 * see this one: by the time the resume read resolves, `applyResumedCursor`
 * has already put account A's watermark in memory, and a discard that re-armed
 * `hydratedSourceKey` without aborting let the pass it just discarded run on
 * into `initializeBackfillQueueIfNeeded` — which short-circuits on any non-null
 * `observedTopUpdatedAt` — and then `enqueueIncrementalUpdates`. So account B
 * skipped its full walk and scanned at account A's position within that pass.
 * The next pass clearing A's derived state does not un-run it.
 *
 * Asserted WITHOUT a `refresh()` on purpose: the observable is what this pass
 * did after the discard, not what the following one repairs.
 */
test("ISS-6067: a discarded resume read must abandon the pass it already seeded a cursor for", async () => {
  gatewayLog.clear();
  const source = new DeferredResumeOutboxSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  source.seedSyncState(SOURCE_KEY_A, {
    observedTopUpdatedAt: CURSOR_AT_A,
    observedIdsAtTopUpdatedAt: [DEAD_UNDER_A],
    deadLetteredIds: [DEAD_UNDER_A],
  });
  let computeTargetId = TARGET_A;
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => computeTargetId,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  computeTargetId = TARGET_B;
  source.releaseRead.resolve([]);
  await service.whenSessionSyncSettled();

  assert.ok(
    !source.listUpdatedCursorCalls.some(
      (call) => call.sinceUpdatedAt === CURSOR_AT_A
    ),
    "account A's watermark must never drive an incremental scan issued under account B"
  );
  service.stop();
});

/**
 * ISS-6067 / ISS-7988, ALLOW sibling — the same fixture with the switch removed,
 * which is what makes the refusal above non-vacuous: resuming the incremental
 * scan at the persisted watermark is exactly what an unsuperseded hydration is
 * REQUIRED to do.
 */
test("ISS-6067: an unsuperseded resume read leaves the pass resuming at its own watermark", async () => {
  gatewayLog.clear();
  const source = new DeferredResumeOutboxSource([
    makeSyncedSession(SESSION_UNDER_B, UPDATED_AT),
  ]);
  source.seedSyncState(SOURCE_KEY_A, {
    observedTopUpdatedAt: CURSOR_AT_A,
    observedIdsAtTopUpdatedAt: [DEAD_UNDER_A],
    deadLetteredIds: [DEAD_UNDER_A],
  });
  const sent: string[][] = [];
  const service = makeService(
    () => source,
    () => TARGET_A,
    (ids) => sent.push(ids)
  );

  service.start();
  await source.readCalled.promise;
  source.releaseRead.resolve([]);
  await service.whenSessionSyncSettled();

  assert.ok(
    source.listUpdatedCursorCalls.some(
      (call) => call.sinceUpdatedAt === CURSOR_AT_A
    ),
    "an unsuperseded hydration must resume the incremental scan from its own persisted watermark"
  );
  service.stop();
});
