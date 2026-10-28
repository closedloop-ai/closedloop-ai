/**
 * @file agent-session-sync-progress-counts.test.ts
 * @description ISS-7099: the pure half of the session lane's progress
 * projection — how many queued sessions the lane could actually send, and the
 * snapshot built from it.
 *
 * The eligibility predicate is the one the drain picks with, so these also pin
 * that the two cannot drift: a queue the drain would skip entirely must not
 * report itself as ready work for a progress bar to divide by.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildAgentSessionSyncProgress,
  countReadyCandidates,
  pickReadyCandidates,
} from "../src/main/agent-sync/agent-session-sync-progress-counts.js";

const NOW_MS = 1_770_000_000_000;
const QUEUE = ["session-1", "session-2", "session-3", "session-4"];

test("a queue with no retry deadlines is entirely ready", () => {
  assert.equal(
    countReadyCandidates({
      queue: QUEUE,
      nextRetryAfterMs: new Map(),
      nowMs: NOW_MS,
    }),
    4
  );
});

test("a deferred session is owed but not ready; an elapsed deadline returns it", () => {
  // One deferral, whichever class set it — they all park the id behind a
  // deadline, so the predicate does not need to know which.
  const deferred = new Map([["session-2", NOW_MS + 30_000]]);
  assert.equal(
    countReadyCandidates({
      queue: QUEUE,
      nextRetryAfterMs: deferred,
      nowMs: NOW_MS,
    }),
    3
  );

  // The queue did not change; only the clock did.
  assert.equal(
    countReadyCandidates({
      queue: QUEUE,
      nextRetryAfterMs: deferred,
      nowMs: NOW_MS + 30_001,
    }),
    4
  );
});

test("a wholly deferred queue reports zero ready while still holding work", () => {
  const allDeferred = new Map(QUEUE.map((id) => [id, NOW_MS + 60_000]));

  assert.equal(
    countReadyCandidates({
      queue: QUEUE,
      nextRetryAfterMs: allDeferred,
      nowMs: NOW_MS,
    }),
    0
  );
  // And the drain agrees — it would pick nothing from this queue either.
  assert.deepEqual(
    pickReadyCandidates({
      queue: QUEUE,
      limit: 3,
      nextRetryAfterMs: allDeferred,
      nowMs: NOW_MS,
    }),
    []
  );
});

test("picking skips deferred ids without reordering the ones it takes", () => {
  const deferred = new Map([["session-2", NOW_MS + 30_000]]);

  assert.deepEqual(
    pickReadyCandidates({
      queue: QUEUE,
      limit: 2,
      nextRetryAfterMs: deferred,
      nowMs: NOW_MS,
    }),
    ["session-1", "session-3"]
  );
});

test("the snapshot separates what is owed from what can move", () => {
  const progress = buildAgentSessionSyncProgress({
    backfillQueue: QUEUE,
    incrementalQueue: ["session-5", "session-6"],
    nextRetryAfterMs: new Map([
      ["session-1", NOW_MS + 30_000],
      ["session-5", NOW_MS + 30_000],
    ]),
    nowMs: NOW_MS,
    hasPendingParts: false,
    sendingIds: [],
    sourceKey: "agent_sessions:target-1",
    hydratedSourceKey: "agent_sessions:target-1",
    initialBackfillPassRun: true,
    delivered: 7,
    inFlightHighWater: 0,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  });

  // The pending counts are unchanged by a deferral — the work is still owed.
  assert.equal(progress.pendingBackfillSessions, 4);
  assert.equal(progress.pendingIncrementalSessions, 2);
  assert.equal(progress.readyBackfillSessions, 3);
  assert.equal(progress.readyIncrementalSessions, 1);
  assert.equal(progress.deliveredSessions, 7);
  assert.equal(progress.inFlightTotalSessions, 11);
  // Deferred work is still work: a queue holding it is not caught up.
  assert.equal(progress.caughtUp, false);
  assert.equal(progress.backfilling, true);
});

test("a fully deferred queue is never reported as caught up", () => {
  // The whole point of keeping `caughtUp` on the QUEUES: if it were keyed on
  // ready work instead, a lane holding sessions it cannot send right now would
  // announce "Sessions synced".
  const progress = buildAgentSessionSyncProgress({
    backfillQueue: QUEUE,
    incrementalQueue: [],
    nextRetryAfterMs: new Map(QUEUE.map((id) => [id, NOW_MS + 60_000])),
    nowMs: NOW_MS,
    hasPendingParts: false,
    sendingIds: [],
    sourceKey: "agent_sessions:target-1",
    hydratedSourceKey: "agent_sessions:target-1",
    initialBackfillPassRun: true,
    delivered: 0,
    inFlightHighWater: 0,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  });

  assert.equal(progress.readyBackfillSessions, 0);
  assert.equal(progress.pendingBackfillSessions, 4);
  assert.equal(progress.caughtUp, false);
});

test("caught-up never leaks across a compute-target switch", () => {
  const progress = buildAgentSessionSyncProgress({
    backfillQueue: [],
    incrementalQueue: [],
    nextRetryAfterMs: new Map(),
    nowMs: NOW_MS,
    hasPendingParts: false,
    sendingIds: [],
    sourceKey: "agent_sessions:target-2",
    hydratedSourceKey: "agent_sessions:target-1",
    initialBackfillPassRun: true,
    delivered: 12,
    inFlightHighWater: 12,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  });

  assert.equal(progress.identified, true);
  assert.equal(progress.caughtUp, false);
  // ISS-7099 (PR #5506 review): `identified` already describes the NEW key while
  // these counters still describe the PRIOR account's work. Publishing them
  // would credit one account with another's deliveries, so all four report
  // "not yet attributable" — which a reader renders as unmeasured, never zero.
  assert.equal(progress.deliveredSessions, null);
  assert.equal(progress.inFlightTotalSessions, null);
  assert.equal(progress.readyBackfillSessions, null);
  assert.equal(progress.readyIncrementalSessions, null);
});

test("a deferral cannot shrink the in-flight total", () => {
  // 40 owed and eligible, so the high-water is 40. Then 30 ack and the last 10
  // are rejected and parked: ready falls to 0. Dividing by what is left eligible
  // would read 30 / 30 and fill the bar for ten sessions that never uploaded.
  const deferred = buildAgentSessionSyncProgress({
    backfillQueue: ["a", "b", "c"],
    incrementalQueue: [],
    nextRetryAfterMs: new Map([
      ["a", NOW_MS + 60_000],
      ["b", NOW_MS + 60_000],
      ["c", NOW_MS + 60_000],
    ]),
    nowMs: NOW_MS,
    hasPendingParts: false,
    sendingIds: [],
    sourceKey: "agent_sessions:target-1",
    hydratedSourceKey: "agent_sessions:target-1",
    initialBackfillPassRun: true,
    delivered: 30,
    inFlightHighWater: 40,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  });

  assert.equal(deferred.readyBackfillSessions, 0);
  assert.equal(deferred.deliveredSessions, 30);
  assert.equal(deferred.inFlightTotalSessions, 40);
});

test("arriving work grows the in-flight total", () => {
  const arrived = buildAgentSessionSyncProgress({
    backfillQueue: ["a", "b", "c", "d", "e"],
    incrementalQueue: [],
    nextRetryAfterMs: new Map(),
    nowMs: NOW_MS,
    hasPendingParts: false,
    sendingIds: [],
    sourceKey: "agent_sessions:target-1",
    hydratedSourceKey: "agent_sessions:target-1",
    initialBackfillPassRun: true,
    delivered: 3,
    inFlightHighWater: 6,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  });

  assert.equal(arrived.inFlightTotalSessions, 8);
});

test("a caught-up lane snaps the total to what it actually delivered", () => {
  // The lane withheld its only session as idle: the queue emptied without a
  // delivery. Caught up means nothing is owed, so work still carried in the
  // high-water left without being delivered and belongs to nobody — keeping it
  // would render "Sessions synced" above a bar reading 0 / 1.
  const settled = buildAgentSessionSyncProgress({
    backfillQueue: [],
    incrementalQueue: [],
    nextRetryAfterMs: new Map(),
    nowMs: NOW_MS,
    hasPendingParts: false,
    sendingIds: [],
    sourceKey: "agent_sessions:target-1",
    hydratedSourceKey: "agent_sessions:target-1",
    initialBackfillPassRun: true,
    delivered: 0,
    inFlightHighWater: 1,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  });

  assert.equal(settled.caughtUp, true);
  assert.equal(settled.deliveredSessions, 0);
  assert.equal(settled.inFlightTotalSessions, 0);
});

// ISS-12529: the upload queue view's in-flight count.
test("sendingSessions counts the batch on the wire that is still queued, never the ready set", () => {
  const progress = buildAgentSessionSyncProgress({
    backfillQueue: QUEUE,
    incrementalQueue: ["session-5"],
    nextRetryAfterMs: new Map(),
    nowMs: NOW_MS,
    hasPendingParts: false,
    // session-9 has already been acked and dequeued; a duplicate id counts once.
    sendingIds: ["session-1", "session-2", "session-2", "session-9"],
    sourceKey: "agent_sessions:target-1",
    hydratedSourceKey: "agent_sessions:target-1",
    initialBackfillPassRun: true,
    delivered: 0,
    inFlightHighWater: 0,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  });

  assert.equal(progress.readyBackfillSessions, 4);
  assert.equal(progress.readyIncrementalSessions, 1);
  assert.equal(progress.sendingSessions, 2);
});

test("sendingSessions is unmeasured until the initial walk has enumerated history", () => {
  const input = {
    backfillQueue: [],
    incrementalQueue: [],
    nextRetryAfterMs: new Map<string, number>(),
    nowMs: NOW_MS,
    hasPendingParts: false,
    sendingIds: [],
    sourceKey: "agent_sessions:target-1",
    hydratedSourceKey: "agent_sessions:target-1",
    initialBackfillPassRun: false,
    delivered: 0,
    inFlightHighWater: 0,
    deadLetteredSessions: 0,
    deadLetteredComponents: 0,
  };
  // Hydrated, but the walk has not listed history: empty queues here mean
  // "not enumerated", not "nothing owed".
  assert.equal(buildAgentSessionSyncProgress(input).sendingSessions, null);
  assert.equal(
    buildAgentSessionSyncProgress({ ...input, initialBackfillPassRun: true })
      .sendingSessions,
    0
  );
  // And never attributed across a compute-target switch.
  assert.equal(
    buildAgentSessionSyncProgress({
      ...input,
      initialBackfillPassRun: true,
      sourceKey: "agent_sessions:target-2",
    }).sendingSessions,
    null
  );
});
