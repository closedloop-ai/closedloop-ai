/**
 * @file agent-session-sync-live-inject.test.ts
 * @description ISS-4546 (ISS-4493 Part 2): integration coverage for
 * `AgentSessionSyncService.injectBackfillIds` — the public API that feeds the
 * data-revision rebuild's outbox ids into the LIVE `backfillQueue` so they drain the same
 * session they were enqueued in, instead of waiting for the next restart's
 * `loadPendingOutboxIds` re-hydration. Drives the real service (not the pure
 * `backfill-queue-feed` helper) so the assertions cover the wiring end to end.
 *
 * Lives in its own suite rather than the grandfathered
 * `agent-session-sync-service.test.ts` so that file does not grow.
 *
 * PR #4098 review (wongk): the completion barrier is a DEFERRED resolved from the
 * real `sendBatch` effect, not a fixed number of `setImmediate` turns, so another
 * async hop can never race the assertions. And durable-outbox rows are seeded under
 * the CANONICAL `buildAgentSessionSyncSourceKey(COMPUTE_TARGET)` — the exact key
 * the service resolves — with a persisted cursor, so the id genuinely drains
 * through the outbox/hydration path rather than the initial corpus walk.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentSessionSyncBatch,
  AgentSessionSyncTransportPayload,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import {
  type AgentSessionSyncSource,
  buildAgentSessionSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import type { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "live-inject-target";
/** The identity the service actually resolves for `COMPUTE_TARGET`. */
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * A service whose `sendBatch` accepts every batch AND signals a fresh deferred each
 * time it is called, so a test can `await` the NEXT real send instead of guessing a
 * turn count. `nextSend()` returns a promise that resolves with the ids of the
 * following send — the durable completion barrier for the fire-and-forget sync.
 */
function makeAcceptingService(
  source: AgentSessionSyncSource,
  sent: AgentSessionSyncBatch[]
): { service: AgentSessionSyncService; nextSend: () => Promise<string[]> } {
  let pending = defer<string[]>();
  const sendBatch = (
    batch: AgentSessionSyncTransportPayload
  ): Promise<
    | { accepted: true }
    | { accepted: false; reason: DesktopAgentSessionsAckReason }
  > => {
    sent.push(batch);
    const ids = batch.sessions.map((session) => session.externalSessionId);
    const current = pending;
    pending = defer<string[]>();
    current.resolve(ids);
    return Promise.resolve({ accepted: true });
  };
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch,
  });
  return { service, nextSend: () => pending.promise };
}

function sentIds(sent: AgentSessionSyncBatch[]): string[] {
  return sent.flatMap((batch) =>
    batch.sessions.map((session) => session.externalSessionId)
  );
}

/**
 * Drive the service until the initial full backfill has drained and the identity
 * is hydrated, so a subsequent `injectBackfillIds` exercises the ALREADY-hydrated
 * path. The starting corpus is fully synced and the outbox cleared on ack.
 */
async function drainInitialBackfill(
  service: AgentSessionSyncService
): Promise<void> {
  service.start();
  await flush();
  service.refresh();
  await flush();
  service.refresh();
  await flush();
}

test("injectBackfillIds feeds an injected id into the live queue and drains it IN-SESSION (no restart)", async () => {
  // One already-synced session at the top watermark. After the initial drain its
  // id is `observed` at the top timestamp, so neither the full-walk short-circuit
  // nor the incremental scan will re-enqueue it — the ONLY path back onto the
  // queue is the inject. This mirrors a real rebuild-changed session that
  // re-derives byte-identical and falls at/below the incremental watermark.
  const changed = makeSyncedSession("changed-1", "2026-07-20T00:00:00.000Z");
  const source = new FakeSyncSource([changed]);
  const sent: AgentSessionSyncBatch[] = [];
  const { service, nextSend } = makeAcceptingService(source, sent);

  await drainInitialBackfill(service);
  assert.deepEqual(sentIds(sent), ["changed-1"]);
  assert.equal(service.getSyncProgress().pendingBackfillSessions, 0);

  // Simulate the production path: the id is durably enqueued to the outbox under the
  // CANONICAL source key AND injected into the live queue with that same captured
  // key. Without the inject it would wait for the next restart.
  source.enqueueOutboxEntries(SOURCE_KEY, [
    { externalSessionId: "changed-1", syncClass: "backfill" },
  ]);
  const injected = nextSend();
  service.injectBackfillIds(["changed-1"], SOURCE_KEY);

  // The inject nudges the loop; the deferred resolves when the real re-send fires,
  // so we await the observable effect rather than a fixed turn count.
  assert.deepEqual(await injected, ["changed-1"]);
  // Delivered a SECOND time this same session — the injected id reached the
  // cloud without a restart.
  assert.deepEqual(sentIds(sent), ["changed-1", "changed-1"]);
  service.stop();
});

test("injectBackfillIds REFUSES ids whose captured capturedSourceKey does not match the live+hydrated identity (A-enqueued/B-hydrated)", async () => {
  // The A-enqueued/B-hydrated identity race (PR #4098 review, wongk P1): the caller
  // captured source key A and durably enqueued A's ids, but the compute target
  // flipped to B and the sync lane hydrated B while the awaited outbox/marker
  // writes ran. Injecting A's ids MUST be refused — otherwise they enter B's live
  // lane, the ack clears B's outbox key, and A stays permanently pending.
  const changed = makeSyncedSession("changed-1", "2026-07-20T00:00:00.000Z");
  const source = new FakeSyncSource([changed]);
  const sent: AgentSessionSyncBatch[] = [];
  const { service } = makeAcceptingService(source, sent);

  await drainInitialBackfill(service);
  assert.deepEqual(sentIds(sent), ["changed-1"]);
  assert.equal(service.getSyncProgress().pendingBackfillSessions, 0);

  // The live/hydrated identity is SOURCE_KEY (target B here). Inject an id captured
  // under a DIFFERENT source key A. The identity-match guard must refuse it.
  const otherSourceKey = buildAgentSessionSyncSourceKey("some-other-target-A");
  service.injectBackfillIds(["changed-1"], otherSourceKey);
  await flush();
  await flush();

  // The queue did not grow and no second send fired: A's ids never entered B's lane.
  assert.equal(
    service.getSyncProgress().pendingBackfillSessions,
    0,
    "an id captured under a non-matching source key must not enter this lane"
  );
  assert.deepEqual(sentIds(sent), ["changed-1"]);
  service.stop();
});

test("injectBackfillIds RECOVERS an injected dead-lettered id (re-pend the durable outbox row + re-queue) instead of leaving it parked", async () => {
  // Dead-letter edge (PR #4098 review, shafty023): the producer re-derived a session the
  // client already corrected on disk, but that id was set aside as a `dead_lettered`
  // straggler with a durable `dead_lettered` outbox row. `enqueueOutboxEntries`
  // preserves that status, and the plain dedup skip would refuse it — leaving the
  // corrected session PARKED as a dead-letter, never re-sent. The inject must RECOVER
  // it: clear the in-memory set-aside AND durably flip the outbox row back to
  // `pending` (so a restart re-discovers it via `loadPendingOutboxIds`), then re-
  // queue it as live backfill work.
  //
  // Determinism: every send is WITHHELD (rejected), so the backfill queue never
  // drains empty. That pins two things without any real-clock/drain race: (1) the
  // idle-cycle `promoteDeadLetterIfIdle` revisit — which only runs when both queues
  // are empty — can never fire, so the ONLY path that could clear `changed-dl`'s
  // set-aside is the inject's own `recoverDeadLetteredId`; and (2) the recovery's
  // observable effects (the in-memory `deadLetteredIds` delete and the durable
  // outbox re-pend) both run SYNCHRONOUSLY inside `injectBackfillIds`, so they are
  // asserted directly after the call rather than after a batch reaches the cloud
  // (a batch-level ack cannot partially accept `changed-dl` while its lane-mate is
  // withheld). A held `blocker` session keeps the queue populated so `changed-dl` is
  // genuinely re-queued as NEW work rather than being the sole idle entry.
  const source = new FakeSyncSource([
    makeSyncedSession("changed-dl", "2026-07-20T00:00:00.000Z"),
    makeSyncedSession("blocker", "2026-07-20T00:00:01.000Z"),
  ]);
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    // WITHHOLD every send so the backfill queue never drains empty (no idle revisit)
    // and the recovery under test is unambiguously the inject's own path.
    sendBatch: () => Promise.reject(new Error("withheld")),
  });

  // Resume from a persisted cursor that records `changed-dl` as a set-aside
  // dead-letter with a durable `dead_lettered` outbox row — the exact parked state.
  // `blocker` is a live pending outbox row that keeps the queue populated.
  source.seedSyncState(SOURCE_KEY, {
    observedTopUpdatedAt: "2026-07-20T00:00:01.000Z",
    observedIdsAtTopUpdatedAt: ["blocker"],
    deadLetteredIds: ["changed-dl"],
  });
  source.seedOutbox(SOURCE_KEY, "changed-dl", "dead_lettered");
  source.seedOutbox(SOURCE_KEY, "blocker", "pending");

  service.start();
  await flush();
  service.refresh();
  await flush();
  // `changed-dl` is still parked: set aside in memory AND `dead_lettered` on disk. The
  // held `blocker` keeps the backfill queue non-empty, so the idle revisit has not
  // (and cannot) promote `changed-dl`.
  assert.equal(service.getSyncProgress().deadLetteredSessions, 1);
  assert.equal(
    source.outbox.get(`${SOURCE_KEY}\0changed-dl`)?.status,
    "dead_lettered"
  );

  // The recovery re-enqueues `changed-dl` durably (status stays `dead_lettered` —
  // `enqueueOutboxEntries` never resurrects a row) and injects it under the captured
  // (matching) source key — the inject's recovery re-pends the parked row.
  source.enqueueOutboxEntries(SOURCE_KEY, [
    { externalSessionId: "changed-dl", syncClass: "backfill" },
  ]);
  service.injectBackfillIds(["changed-dl"], SOURCE_KEY);

  // Recovery ran synchronously inside the inject: the in-memory set-aside is cleared
  // and the durable outbox row flipped back to `pending`, so a restart would re-
  // discover `changed-dl` via `loadPendingOutboxIds`. `changed-dl` is now live backfill
  // work rather than a parked dead-letter.
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "the recovered id must no longer be a set-aside dead-letter"
  );
  assert.equal(
    source.outbox.get(`${SOURCE_KEY}\0changed-dl`)?.status,
    "pending",
    "the recovered dead-letter must be re-pended in the durable outbox"
  );
  service.stop();
});

test("injectBackfillIds is DEDUP-SAFE: an id already on the backfill queue is not double-queued", async () => {
  // WITHHOLD every send so the backfill queue stays populated across the inject —
  // this isolates the dedup guard from send/ack timing (an acked id is legitimately
  // re-queueable). `sendBatch` never accepts, so `s1`/`s2` remain queued.
  const source = new FakeSyncSource([
    makeSyncedSession("s1", "2026-07-20T00:00:01.000Z"),
    makeSyncedSession("s2", "2026-07-20T00:00:02.000Z"),
  ]);
  let sendCalls = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: () => {
      sendCalls += 1;
      // Never resolve accepted → the batch stays queued (retryable transport
      // failure), so the queue population is stable for the dedup assertion.
      return Promise.reject(new Error("withheld"));
    },
  });

  service.start();
  await flush();
  // First tick hydrates + enqueues the backfill; both ids are now queued/tracked
  // (and the withheld send left them queued).
  const queuedBefore = service.getSyncProgress().pendingBackfillSessions;
  assert.equal(queuedBefore, 2);

  // Inject one of the already-queued ids — the dedup guard must drop it, so the
  // queue depth does NOT grow to 3.
  service.injectBackfillIds(["s1"], SOURCE_KEY);
  await flush();
  assert.equal(
    service.getSyncProgress().pendingBackfillSessions,
    2,
    "re-injecting an already-queued id must not grow the backfill queue"
  );
  assert.ok(sendCalls > 0);
  service.stop();
});

test("HYDRATION-FIRST: injecting BEFORE the first hydration does not preempt the full-walk, and the id still drains via hydration", async () => {
  // A durable pending outbox id whose session exists in the corpus, seeded under the
  // CANONICAL source key with a persisted cursor whose watermark already observed
  // the corpus top — so the initial full-walk is short-circuited and the ONLY path
  // back for `pending-1` is the outbox re-enqueue at hydration (not the corpus
  // walk). We inject it BEFORE any sync tick runs (identity not yet hydrated): the
  // inject MUST be a no-op (never push ahead of the pending hydration), yet the id
  // must STILL be delivered exactly once via the hydration path — proving no
  // preemption AND no stranding.
  const session = makeSyncedSession("pending-1", "2026-07-20T00:00:00.000Z");
  const source = new FakeSyncSource([session]);
  source.seedSyncState(SOURCE_KEY, {
    observedTopUpdatedAt: "2026-07-20T00:00:00.000Z",
    observedIdsAtTopUpdatedAt: ["pending-1"],
  });
  source.enqueueOutboxEntries(SOURCE_KEY, [
    { externalSessionId: "pending-1", syncClass: "backfill" },
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const { service, nextSend } = makeAcceptingService(source, sent);

  // Inject BEFORE start/hydration — hydratedSourceKey is still null.
  service.injectBackfillIds(["pending-1"], SOURCE_KEY);
  // Nothing queued yet: the inject was correctly withheld (hydration-first).
  assert.equal(service.getSyncProgress().pendingBackfillSessions, 0);

  // Now run the sync lane. Hydration runs first (its `loadPendingOutboxIds`
  // re-enqueue is the ONLY path back for this id, since the persisted watermark
  // skips the corpus walk), and the id drains through that path.
  const drained = nextSend();
  service.start();
  await flush();
  service.refresh();
  await flush();

  assert.deepEqual(
    await drained,
    ["pending-1"],
    "the id drains exactly once via the outbox hydration path — not preempted, not stranded"
  );
  assert.deepEqual(
    sentIds(sent).filter((id) => id === "pending-1"),
    ["pending-1"]
  );
  service.stop();
});
