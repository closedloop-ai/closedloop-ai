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
import test from "node:test";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { flushAgentSessionSync } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TARGET_A = "target-iss-6031-account-a";
const TARGET_B = "target-iss-6031-account-b";
const SOURCE_KEY_A = buildAgentSessionSyncSourceKey(TARGET_A);
const SESSION_ID = "session-selected-under-account-a";
const UPDATED_AT = "2026-08-12T03:29:06.102Z";

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

function makeService(
  getSource: () => FakeSyncSource,
  getComputeTargetId: () => string,
  onBatch: (ids: string[]) => void
): AgentSessionSyncService {
  return new AgentSessionSyncService({
    isHttpReady: () => true,
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
