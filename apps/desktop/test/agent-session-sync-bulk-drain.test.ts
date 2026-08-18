/**
 * @file agent-session-sync-bulk-drain.test.ts
 * @description FEA-4375 regression coverage for bulk initial session-sync
 * resilience.
 *
 * The observed complaint: a large first-connect corpus (~1800 local sessions)
 * "hangs" a few sessions in and never completes. The residual root cause after
 * the earlier per-item-isolation fixes (FEA-4014 worker timeout + isolated prep,
 * FEA-4152 chunk sizing) is pure THROUGHPUT: the `setInterval` sync tick uploads
 * at most `BACKFILL_SESSION_BATCH_SIZE` (3) sessions per 5-second poll, so a
 * large corpus is capped at ~3 sessions / 5s ≈ 50 minutes even when nothing is
 * wedged.
 *
 * The fix self-continues the drain: after a productive batch (an accepted ack OR
 * a dead-letter skip) the service immediately schedules the next SESSION-ONLY
 * tick when ready work remains, bounded only by the network round-trip, so the
 * corpus drains in a few minutes. These tests assert:
 *
 *   1. A multi-batch corpus drains to completion from a SINGLE `start()` without
 *      manually pumping one `refresh()` per batch (i.e. the service self-continues
 *      instead of waiting the 5s poll for every batch).
 *   2. A poison session mid-corpus is dead-lettered and the surrounding sessions
 *      still drain to completion — one bad unit never wedges the queue or leaves
 *      the drain unresolved.
 *   3. A persistently-failing transient send dead-letters after the BOUNDED
 *      transport-error budget (never infinitely), and the neighbors drain.
 *   4. A batch-level `validation_failed` (the real ack boundary carries no
 *      per-item ids) on a mixed healthy+malformed envelope is BISECTED down to
 *      the single failing row: the healthy neighbors ack and the offender alone
 *      dead-letters, rather than the whole batch being discarded.
 *   5. Progress counts reflect processed + dead-lettered against the total.
 *   6. A corpus dominated by idle/phantom rows still drains from a single start.
 *
 * DETERMINISM (FEA-2399 / desktop AGENTS.md "test:node determinism"): each test
 * synchronizes on the real observable completion effect — `getSyncProgress()`
 * reaching a settled state — via `waitForSyncSettled`, which pumps event-loop
 * turns and THROWS if the settle never lands within a generous budget. It never
 * falls through silently onto a stale-state assertion.
 *
 * Uses the shared `FakeSyncSource` fixture and drives the real
 * `AgentSessionSyncService` exactly like `agent-session-sync-service.test.ts`.
 * A `getSyncComputeTargetId` is supplied so the source identity resolves and
 * `getSyncProgress().caughtUp` is meaningful.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACK_OMITTED_BACKOFF_MS,
  MAX_CONSECUTIVE_ACK_OMITTED,
  MAX_CONSECUTIVE_TRANSPORT_ERRORS,
  MAX_CONSECUTIVE_VALIDATION_FAILED,
  VALIDATION_FAILED_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionPayloadPreparer } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { prepareAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncProgress } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { acceptedResult } from "./agent-session-sync-component-test-utils.js";
import { pumpSyncDrainTurn } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "bulk-drain-target";

// A serialization-keyword message so the service classifies the prep failure as
// a DETERMINISTIC local bug and dead-letters it immediately (see
// isLocalSerializationError), rather than spending the transient retry budget
// across poll ticks.
const SERIALIZE_FAILURE_MESSAGE = "cannot serialize payload";

// The bounded settle budget: how many drain turns to pump before declaring the
// drain wedged. Each turn advances BOTH phases the self-continue depends on (see
// `pumpSyncDrainTurn`), so one turn costs at most one chained drain tick on any
// machine and the budget is a real wedge detector rather than a speed race. A
// few hundred turns covers a multi-batch corpus with wide margin, and exhausting
// it means the drain truly never settled (a real regression) — which we surface
// as a loud throw.
const MAX_SETTLE_TURNS = 500;

/**
 * Synchronize on the REAL observable completion effect: pump event-loop turns
 * until `predicate(getSyncProgress())` holds, then return. If the predicate
 * never holds within `MAX_SETTLE_TURNS`, THROW — a silent fall-through onto a
 * stale-state assertion is exactly the flake the FEA-2399 guard forbids, so a
 * missed settle must surface as an explicit, labeled timeout.
 */
async function waitForSyncSettled(
  service: AgentSessionSyncService,
  predicate: (progress: AgentSessionSyncProgress) => boolean,
  label: string
): Promise<void> {
  for (let turn = 0; turn < MAX_SETTLE_TURNS; turn += 1) {
    if (predicate(service.getSyncProgress())) {
      return;
    }
    await pumpSyncDrainTurn();
  }
  throw new Error(
    `sync drain never settled after ${MAX_SETTLE_TURNS} turns waiting for: ${label} ` +
      `(last progress: ${JSON.stringify(service.getSyncProgress())})`
  );
}

/** Settle predicate: the corpus is fully accounted for (nothing left pending). */
function caughtUp(progress: AgentSessionSyncProgress): boolean {
  return (
    progress.caughtUp &&
    progress.pendingBackfillSessions === 0 &&
    progress.pendingIncrementalSessions === 0
  );
}

/**
 * Freeze `Date.now` and expose an `advance(ms)` so a test can step past the
 * per-session retry backoffs (e.g. VALIDATION_FAILED_BACKOFF_MS) DETERMINISTICALLY
 * instead of waiting real wall-clock time. Only the clock is mocked (not the
 * timer queue); the test drives ticks explicitly via `refresh()`. Restores the
 * real `Date.now` in a finally so a failing assertion never leaks the mock.
 */
async function withMockedNow(
  body: (clock: { advance: (ms: number) => void }) => Promise<void>
): Promise<void> {
  const realNow = Date.now;
  let virtualNow = realNow();
  Date.now = () => virtualNow;
  try {
    await body({
      advance: (ms) => {
        virtualNow += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

function makeBulkSource(count: number): FakeSyncSource {
  const sessions: SyncedAgentSession[] = [];
  for (let i = 0; i < count; i++) {
    const minute = String(i % 60).padStart(2, "0");
    const hour = String(12 + Math.floor(i / 60)).padStart(2, "0");
    sessions.push(
      makeSyncedSession(`session-${i}`, `2026-06-08T${hour}:${minute}:00.000Z`)
    );
  }
  return new FakeSyncSource(sessions);
}

function rejectingSerializePreparer(
  poisonId: string
): AgentSessionPayloadPreparer {
  return (sessions, maxBytes) => {
    if (sessions.some((s) => s.externalSessionId === poisonId)) {
      return Promise.reject(new TypeError(SERIALIZE_FAILURE_MESSAGE));
    }
    return Promise.resolve(
      sessions.map((session) => prepareAgentSessionPayload(session, maxBytes))
    );
  };
}

// An idle ("phantom") session: a SessionStart-only row with no tokens and no
// tool-use, which the sync boundary withholds from upload (dropIdleCandidates)
// without dead-lettering. Modeled on `makeIdleSession` in the sibling suite.
function makeIdleBulkSession(
  id: string,
  updatedAt: string
): SyncedAgentSession {
  return {
    externalSessionId: id,
    status: "active",
    harness: "codex",
    cwd: `/workspace/${id}`,
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt,
    agents: [],
    events: [
      {
        externalEventId: `${id}-session-start`,
        eventType: "SessionStart",
        createdAt: "2026-06-08T12:00:00.000Z",
      },
    ],
    tokenUsageByModel: [],
  };
}

test("FEA-4375: a multi-batch corpus drains to completion from a single start (no 5s wait per batch)", async () => {
  // 30 sessions = 10 backfill batches of 3. Without the self-continuing drain
  // this would need 10 separate poll ticks; here a single start() must drain the
  // whole corpus because each accepted batch immediately schedules the next.
  const source = makeBulkSource(30);
  const sentIds = new Set<string>();
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async (batch) => {
      for (const session of batch.sessions) {
        sentIds.add(session.externalSessionId);
      }
      return { accepted: true };
    },
  });

  service.start();
  await waitForSyncSettled(service, caughtUp, "30-session corpus caught up");
  service.stop();

  assert.equal(sentIds.size, 30, "every session in the corpus was uploaded");
  assert.equal(service.getSyncProgress().deadLetteredSessions, 0);
});

test("ISS-5085: a ready multi-batch incremental backlog drains without 30s pauses", async () => {
  const source = makeBulkSource(30);
  const sourceKey = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
  source.seedSyncState(sourceKey, {
    observedTopUpdatedAt: "2026-06-08T11:59:00.000Z",
    observedIdsAtTopUpdatedAt: [],
  });
  const sentIds = new Set<string>();
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async (batch) => {
      for (const session of batch.sessions) {
        sentIds.add(session.externalSessionId);
      }
      return { accepted: true };
    },
  });

  // Date.now never advances in this test. The 30 rows therefore reach cloud
  // only if full incremental batches self-continue instead of waiting for three
  // separate MIN_INCREMENTAL_SYNC_INTERVAL_MS windows.
  await withMockedNow(async () => {
    service.start();
    await waitForSyncSettled(
      service,
      caughtUp,
      "30-session incremental backlog caught up"
    );
  });
  service.stop();

  assert.equal(sentIds.size, 30, "every ready incremental row was uploaded");
});

test("FEA-4375: the session-only self-continue drain does NOT re-enter the component lane per session batch", async () => {
  // wongk: the immediate self-continue must advance the SESSION lane only. If it
  // re-entered the full syncOnce() (which also kicks syncComponentsOnce()), a
  // fast component-lane failure would be retried once per session batch during a
  // large backfill instead of on its documented 5s tick. This drives a 30-session
  // corpus (10 backfill batches) that drains from a SINGLE start() via the
  // self-continue, wires a component lane that ALWAYS fails, and asserts the
  // component lane's entry point (listComponentCursorRows) fired only for the
  // real syncOnce tick(s) from start() — a small bounded count — NOT ~10 (once
  // per self-continued session batch).
  const source = makeBulkSource(30);
  const sentIds = new Set<string>();
  let componentLaneEntries = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async (batch) => {
      for (const session of batch.sessions) {
        sentIds.add(session.externalSessionId);
      }
      return { accepted: true };
    },
    // A component lane that always "fails" its cursor read. Each entry counts;
    // the session-only self-continue must NOT drive this per session batch.
    listComponentCursorRows: async () => {
      componentLaneEntries += 1;
      throw new Error("component-lane cursor read failed");
    },
    loadComponentRows: async () => [],
    sendComponents: async () => acceptedResult(),
  });

  service.start();
  await waitForSyncSettled(service, caughtUp, "30-session corpus caught up");
  service.stop();

  assert.equal(sentIds.size, 30, "every session drained from the single start");
  // The 30-session corpus self-continued across ~10 session batches. The
  // component lane is entered only by the real syncOnce tick from start() (a
  // single-flight guard collapses re-entry within a tick), so its entry count
  // must stay far below the session-batch count — proving the self-continue ran
  // session-only. A per-batch re-entry regression would push this to ~10+.
  assert.ok(
    componentLaneEntries <= 2,
    `component lane entered ${componentLaneEntries} times — the session-only self-continue must not re-enter it per session batch (expected <= 2, one real syncOnce tick)`
  );
});

test("FEA-4375: a poison session mid-corpus is dead-lettered and its neighbors still drain", async () => {
  const source = makeBulkSource(15);
  const poisonId = "session-7";
  const sentIds = new Set<string>();
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    preparePayloads: rejectingSerializePreparer(poisonId),
    sendBatch: async (batch) => {
      for (const session of batch.sessions) {
        sentIds.add(session.externalSessionId);
      }
      return { accepted: true };
    },
  });

  service.start();
  await waitForSyncSettled(
    service,
    (progress) => caughtUp(progress) && progress.deadLetteredSessions === 1,
    "14 healthy synced + 1 poison dead-lettered"
  );
  const progress = service.getSyncProgress();
  service.stop();

  assert.ok(
    !sentIds.has(poisonId),
    "the poison session was never accepted for upload"
  );
  assert.equal(
    sentIds.size,
    14,
    "all 14 healthy sessions drained past the poison one"
  );
  assert.equal(
    progress.deadLetteredSessions,
    1,
    "exactly the poison session was dead-lettered"
  );
});

test("FEA-4375: a persistently-failing send is bounded-retried then dead-lettered, and the queue drains", async () => {
  // A single flaky session so its transport throws never charge healthy siblings
  // (a batch-level send throw charges every id in the batch — see
  // handleTransportError). This isolates the bounded-retry-then-dead-letter
  // contract: the send must NOT retry forever; after
  // MAX_CONSECUTIVE_TRANSPORT_ERRORS throws the session dead-letters and the
  // queue drains to empty instead of wedging.
  const flakyId = "solo-flaky";
  const source = new FakeSyncSource([
    makeSyncedSession(flakyId, "2026-06-08T12:00:00.000Z"),
  ]);
  let attempts = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => {
      attempts += 1;
      // A persistent transport fault (socket drop): it must dead-letter after
      // MAX_CONSECUTIVE_TRANSPORT_ERRORS consecutive throws, never loop forever.
      throw new Error(`socket drop (attempt ${attempts})`);
    },
  });

  service.start();
  // A thrown transport error is transient and NOT productive: it stays queued
  // without an immediate reschedule, and is retried on each poll tick until the
  // bounded budget trips. Drive those poll ticks explicitly with refresh() (the
  // real setInterval fires syncOnce the same way) so the test does not depend on
  // wall-clock time, then settle on the observable dead-letter.
  for (
    let tick = 0;
    tick <= MAX_CONSECUTIVE_TRANSPORT_ERRORS + 2 &&
    service.getSyncProgress().deadLetteredSessions === 0;
    tick++
  ) {
    service.refresh();
    await pumpSyncDrainTurn();
  }
  await waitForSyncSettled(
    service,
    (progress) =>
      progress.deadLetteredSessions === 1 &&
      progress.pendingBackfillSessions === 0,
    "the flaky session dead-lettered and the queue drained"
  );
  const progress = service.getSyncProgress();
  service.stop();

  assert.ok(
    attempts >= MAX_CONSECUTIVE_TRANSPORT_ERRORS,
    "the transient failure was retried up to the bounded budget before dead-letter"
  );
  assert.equal(
    progress.deadLetteredSessions,
    1,
    "the persistently-failing session dead-lettered (bounded, not infinite)"
  );
});

test("FEA-4375: validation_failed dead-letters only the rejected row and keeps healthy neighbors draining", async () => {
  // The current shared API limit is one session per request, so this exercises
  // the reachable contract: the rejected row spends its own validation budget
  // while healthy neighbors before and after it continue to ack.
  const source = makeBulkSource(6);
  const badId = "session-2";
  const acceptedIds = new Set<string>();
  const rejectedEnvelopeSizes: number[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async (batch) => {
      const ids = batch.sessions.map((s) => s.externalSessionId);
      if (ids.includes(badId)) {
        rejectedEnvelopeSizes.push(ids.length);
        return {
          accepted: false,
          reason: DesktopAgentSessionsAckReason.ValidationFailed,
        };
      }
      for (const id of ids) {
        acceptedIds.add(id);
      }
      return { accepted: true };
    },
  });

  // The bisection singletons are re-sent behind VALIDATION_FAILED_BACKOFF_MS, so
  // pin the clock and step past each backoff window between refresh()-driven
  // ticks — deterministic, no real wall-clock wait. Fail loud if the drain never
  // settles within a bounded number of steps.
  await withMockedNow(async ({ advance }) => {
    service.start();
    let settled = false;
    for (let tick = 0; tick < 20; tick += 1) {
      await pumpSyncDrainTurn();
      const progress = service.getSyncProgress();
      if (caughtUp(progress) && progress.deadLetteredSessions === 1) {
        settled = true;
        break;
      }
      // Step past the per-session validation backoff so the next tick actually
      // re-selects the deferred bisection singletons.
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      service.refresh();
    }
    assert.ok(
      settled,
      `bisection never settled: ${JSON.stringify(service.getSyncProgress())}`
    );
  });
  const progress = service.getSyncProgress();
  service.stop();

  assert.ok(
    !acceptedIds.has(badId),
    "the malformed row was never accepted by the server"
  );
  assert.equal(
    acceptedIds.size,
    5,
    "all healthy neighbors still synced around the rejected row"
  );
  assert.equal(
    progress.deadLetteredSessions,
    1,
    "only the single malformed row dead-lettered"
  );
  assert.ok(
    rejectedEnvelopeSizes.filter((size) => size === 1).length >=
      MAX_CONSECUTIVE_VALIDATION_FAILED,
    "the bad row was retried alone until it spent its own validation budget"
  );
});

test("FEA-4375 / goal stage 2: rows the server keeps omitting from the ack echo dead-letter on a bounded budget while their neighbors drain", async () => {
  // Originally (shafty023 P2 / wongk) this pinned the terminal-dead-letter
  // self-continue with a POISON LEADING BATCH: pre-ISS-5988 envelopes carried 3
  // sessions, so the poison rows and the healthy rows travelled in separate
  // envelopes and an all-poison envelope could be rejected wholesale. With
  // byte-budgeted batching the whole six-session corpus ships as ONE envelope,
  // so a whole-envelope rejection can no longer isolate the poison rows — but
  // the stage-2 row-level ack can: the server accepts each envelope and its
  // `acceptedSessionIds` echo confirms only the healthy rows. The omitted rows
  // must burn the bounded `ack_omitted` budget (deferred with backoff between
  // attempts, never retried forever) and then dead-letter RECOVERABLY, while
  // the healthy neighbors in the very same envelope ack and clear on the first
  // pass — one persistently-unconfirmed row never wedges the drain.
  const source = makeBulkSource(6);
  const poisonIds = new Set(["session-0", "session-1", "session-2"]);
  const acceptedIds = new Set<string>();
  let omissionPasses = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async (batch) => {
      const ids = batch.sessions.map((s) => s.externalSessionId);
      const confirmed = ids.filter((id) => !poisonIds.has(id));
      if (confirmed.length < ids.length) {
        omissionPasses += 1;
      }
      for (const id of confirmed) {
        acceptedIds.add(id);
      }
      return { accepted: true, acceptedSessionIds: confirmed };
    },
  });

  // ack_omitted defers behind ACK_OMITTED_BACKOFF_MS, so pin the clock and step
  // past each backoff window between refresh()-driven ticks — the same
  // deterministic pattern as the bisection test, no real wall-clock wait. Once
  // the omitted rows burn their budget and dead-letter, the drain must settle
  // within these bounded steps (a fall-through means a regression).
  await withMockedNow(async ({ advance }) => {
    service.start();
    let settled = false;
    for (let tick = 0; tick < 30; tick += 1) {
      await pumpSyncDrainTurn();
      const progress = service.getSyncProgress();
      if (caughtUp(progress) && progress.deadLetteredSessions === 3) {
        settled = true;
        break;
      }
      advance(ACK_OMITTED_BACKOFF_MS + 1);
      service.refresh();
    }
    assert.ok(
      settled,
      `ack-omitted dead-letter drain never settled: ${JSON.stringify(service.getSyncProgress())}`
    );
  });
  const progress = service.getSyncProgress();
  service.stop();

  assert.deepEqual(
    [...acceptedIds].sort(),
    ["session-3", "session-4", "session-5"],
    "exactly the healthy neighbors synced (first pass); no omitted row was ever cleared"
  );
  assert.equal(
    progress.deadLetteredSessions,
    3,
    "the persistently-omitted rows dead-lettered after their ack_omitted budget"
  );
  assert.ok(
    omissionPasses >= MAX_CONSECUTIVE_ACK_OMITTED,
    "the omitted rows were re-sent up to their bounded ack_omitted budget before dead-letter"
  );
});

test("FEA-4375: progress reflects processed + dead-lettered against the total", async () => {
  const source = makeBulkSource(9);
  const poisonId = "session-4";
  const sentIds = new Set<string>();
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    preparePayloads: rejectingSerializePreparer(poisonId),
    sendBatch: async (batch) => {
      for (const session of batch.sessions) {
        sentIds.add(session.externalSessionId);
      }
      return { accepted: true };
    },
  });

  service.start();
  // 9 total = 8 synced + 1 dead-lettered, and the queue is empty (all accounted
  // for). The progress surface never leaves work "pending" for the bad item.
  await waitForSyncSettled(
    service,
    (progress) => caughtUp(progress) && progress.deadLetteredSessions === 1,
    "8 synced + 1 dead-lettered accounts for the 9-session corpus"
  );
  const progress = service.getSyncProgress();
  service.stop();

  assert.equal(sentIds.size, 8);
  assert.equal(progress.deadLetteredSessions, 1);
});

test("FEA-4375: a corpus dominated by idle/phantom rows still drains from a single start", async () => {
  // Idle rows are dequeued (withheld) WITHOUT dead-lettering, on a code path that
  // returns from syncOnce before reaching the ack handler. If that drop did not
  // self-continue the drain, a corpus that is mostly idle would throttle back to
  // one batch per 5s poll. Interleave many idle rows with a few substantive ones
  // and assert the whole corpus is accounted for from a single start().
  const sessions: SyncedAgentSession[] = [];
  const substantiveIds: string[] = [];
  for (let i = 0; i < 24; i++) {
    const minute = String(i % 60).padStart(2, "0");
    const updatedAt = `2026-06-08T12:${minute}:00.000Z`;
    if (i % 4 === 0) {
      const id = `substantive-${i}`;
      substantiveIds.push(id);
      sessions.push(makeSyncedSession(id, updatedAt));
    } else {
      sessions.push(makeIdleBulkSession(`idle-${i}`, updatedAt));
    }
  }
  const source = new FakeSyncSource(sessions);
  const sentIds = new Set<string>();
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async (batch) => {
      for (const session of batch.sessions) {
        sentIds.add(session.externalSessionId);
      }
      return { accepted: true };
    },
  });

  service.start();
  await waitForSyncSettled(
    service,
    (progress) => caughtUp(progress) && progress.deadLetteredSessions === 0,
    "idle-dominated corpus fully drained (only substantive rows uploaded)"
  );
  service.stop();

  assert.deepEqual(
    [...sentIds].sort(),
    [...substantiveIds].sort(),
    "exactly the substantive sessions were uploaded"
  );
});
