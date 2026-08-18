/**
 * @file agent-session-sync-progress.test.ts
 * @description FEA-2733: `getSyncProgress()` — the content-blind snapshot that
 * drives the renderer "syncing your history" indicator. Split out of the
 * (grandfathered, shrink-only) main sync-service suite.
 *
 * These assert the state machine the UI depends on: a draining first-connect
 * backfill settles to caughtUp, an empty store is caught up after the first
 * pass, caughtUp never leaks across a compute-target (account) switch, and a
 * resumed persisted cursor still flips the initial-pass flag so the indicator
 * cannot latch on "checking" forever.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
  settleSelfContinuedDrain,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

test("getSyncProgress reflects a draining first-connect backfill, then settles to caught up", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("session-1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("session-2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("session-3", "2026-06-08T12:03:00.000Z"),
    makeSyncedSession("session-4", "2026-06-08T12:04:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    "target-progress"
  );

  // Before the first tick: identified (identity known from options) but the
  // walk has not enumerated history yet — must NOT report "up to date".
  assert.equal(service.getSyncProgress().caughtUp, false);
  assert.equal(service.getSyncProgress().identified, true);

  // Tick 1 enqueues all four historical sessions and sends the first backfill
  // batch (BACKFILL_SESSION_BATCH_SIZE = 3). FEA-4375 self-continues the drain:
  // after that productive batch the service immediately schedules the next tick
  // (a `setTimeout(0)` drain) instead of idling the 5s poll, so the remaining
  // session drains on its own without a manual `refresh()`. Pump a bounded
  // number of flushes to let the chained self-rescheduled ticks settle the queue.
  service.start();
  await settleSelfContinuedDrain(service);

  // The queues empty and the snapshot settles to caught up. Assert BEFORE stop():
  // stop() → resetSourceState() zeroes the flag and queues, so a post-stop
  // snapshot would read a cleared state, not the settled one.
  assert.deepEqual(service.getSyncProgress(), {
    identified: true,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
    backfilling: false,
    caughtUp: true,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  });
  service.stop();
});

test("getSyncProgress reports caught up for an empty local store after the first pass", async () => {
  const source = new FakeSyncSource([]);
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    "target-empty"
  );

  // Nothing enumerated yet → not caught up (avoids a premature "up to date").
  assert.equal(service.getSyncProgress().caughtUp, false);

  service.start();
  await flushAgentSessionSync();

  // The initial enumeration ran (0 rows) so there is genuinely nothing to
  // sync: caught up, not backfilling, nothing pending. Assert before stop(),
  // which would otherwise clear the flag/queues this snapshot reads.
  assert.deepEqual(service.getSyncProgress(), {
    identified: true,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
    backfilling: false,
    caughtUp: true,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  });
  service.stop();
});

test("getSyncProgress never leaks a caught-up state across a compute-target switch", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("session-1", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("session-2", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("session-3", "2026-06-08T12:03:00.000Z"),
    makeSyncedSession("session-4", "2026-06-08T12:04:00.000Z"),
  ]);
  let currentTarget = "target-A";
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => currentTarget,
    sendBatch: async () => ({ accepted: true }),
  });

  try {
    // Fully drain the backfill for account A → caught up.
    service.start();
    await settleSelfContinuedDrain(service);
    assert.equal(service.getSyncProgress().caughtUp, true);
    const walksAfterAccountA = source.listAllCursorCallCount;

    // Switch accounts. ISS-4758: the leak-guard is a property of the SNAPSHOT
    // ITSELF and is observable before any tick runs — `caughtUp` is gated on the
    // resolved source key matching `hydratedSourceKey`, so this needs no event
    // loop at all and cannot race. The old version instead pumped one tick and
    // asserted an exact mid-walk depth (`pendingBackfillSessions === 1`), which
    // FEA-4375's self-continuing drain can blow straight past on a loaded
    // runner — it drained all four and reported caught-up (`true !== false`).
    currentTarget = "target-B";
    assert.equal(
      service.getSyncProgress().caughtUp,
      false,
      "account A's caught-up must never carry across a compute-target switch"
    );

    // The next tick re-hydrates for the new identity (no seeded cursor) and
    // restarts the FULL corpus walk for account B, rather than inheriting A's
    // cursor. Assert that the restart happened, not how far it had got.
    service.refresh();
    await settleSelfContinuedDrain(service);
    assert.ok(
      source.listAllCursorCallCount > walksAfterAccountA,
      "the switched-to identity restarts a full corpus walk instead of resuming account A's cursor"
    );
  } finally {
    service.stop();
  }
});

test("getSyncProgress settles to caught up on a resumed persisted cursor (already-synced restart)", async () => {
  // An already-synced user restarts: `hydratePersistedCursorIfNeeded` resumes
  // the persisted cursor and `initializeBackfillQueueIfNeeded` skips the full
  // walk. `initialBackfillPassRun` must still flip on that skip path, or the
  // indicator latches on "checking" forever instead of "up to date".
  const source = new FakeSyncSource([
    makeSyncedSession("old", "2026-06-08T12:00:00.000Z"),
    makeSyncedSession("top", "2026-06-08T12:05:00.000Z"),
  ]);
  const key = buildAgentSessionSyncSourceKey("target-resumed");
  source.seedSyncState(key, {
    observedTopUpdatedAt: "2026-06-08T12:05:00.000Z",
    observedIdsAtTopUpdatedAt: ["top"],
  });
  const service = makeServiceWithIdentity(
    source,
    async () => ({ accepted: true }),
    "target-resumed"
  );

  service.start();
  await flushAgentSessionSync();

  // No backfill was queued (cursor resumed) yet the snapshot is caught up.
  const progress = service.getSyncProgress();
  assert.equal(progress.caughtUp, true);
  assert.equal(progress.backfilling, false);
  assert.equal(progress.pendingBackfillSessions, 0);
  service.stop();
});
