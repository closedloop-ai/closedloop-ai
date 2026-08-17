/**
 * @file agent-component-sync-dead-letter.test.ts
 * @description Unit coverage for the ISS-4542 component-sync dead-letter tracker
 * (`ComponentSyncDeadLetterTracker`). Exercises the pure state machine directly
 * with an explicit `nowMs` clock (no wall-clock reliance): the bounded per-
 * boundary failure budget, dead-lettering a batch to the back of the line, the
 * drained re-attempt selection, the doubling backoff, and the bounded
 * quarantine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceComponentCursor,
  buildComponentBoundaryKey,
  COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD,
  COMPONENT_DEAD_LETTER_MAX_ATTEMPTS,
  COMPONENT_DEAD_LETTER_RETRY_BASE_MS,
  COMPONENT_DEAD_LETTER_RETRY_MAX_MS,
  COMPONENT_MAX_DEAD_LETTERED_IDS,
  ComponentCursorPersistOutcome,
  ComponentSyncDeadLetterTracker,
  ComponentSyncSendOutcome,
  type ComponentSyncSendResult,
  classifyComponentSyncHttpStatus,
  componentDeadLetterRetryDelayMs,
  recoverComponentDeadLetters,
} from "../src/main/agent-sync/agent-component-sync-dead-letter.js";

const BOUNDARY = buildComponentBoundaryKey("2026-07-29T00:00:00.000Z", "id-0");

test("dead-letter: a batch is retried in place below the threshold, then dead-lettered to the back at the threshold", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const ids = ["a", "b", "c"];
  const now = 1_000_000;

  // Below the threshold: retry in place, nothing dead-lettered yet.
  for (let i = 1; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    const dead = tracker.recordBatchFailure(BOUNDARY, ids, now);
    assert.equal(
      dead,
      false,
      `failure ${i} must not dead-letter (below budget)`
    );
    assert.equal(tracker.size, 0, "nothing dead-lettered below the budget");
  }

  // At the threshold: the whole batch dead-letters to the back of the line.
  const dead = tracker.recordBatchFailure(BOUNDARY, ids, now);
  assert.equal(dead, true, "reaching the budget dead-letters the batch");
  assert.equal(
    tracker.size,
    ids.length,
    "every id in the batch is dead-lettered"
  );
});

test("dead-letter: a successful send clears the boundary's failure budget", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 2_000_000;
  // One below threshold, then a success clears it, so the next failure starts
  // fresh and does NOT tip into a dead-letter early.
  for (let i = 1; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["a"], now);
  }
  tracker.clearBoundary(BOUNDARY);
  const dead = tracker.recordBatchFailure(BOUNDARY, ["a"], now);
  assert.equal(
    dead,
    false,
    "budget reset by clearBoundary — one failure is not a dead-letter"
  );
  assert.equal(tracker.size, 0, "nothing dead-lettered after the reset");
});

test("dead-letter: a due id is re-attempted immediately after the initial dead-letter, and a successful re-attempt clears it", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 3_000_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["a"], now);
  }
  assert.equal(tracker.size, 1);

  // The initial dead-letter is due immediately (a deferral to the back, not a
  // delay), so once the lane drains it is picked for re-attempt.
  const due = tracker.takeDueDeadLetters(now, 10);
  assert.deepEqual(
    due,
    ["a"],
    "the freshly dead-lettered id is due immediately"
  );

  tracker.noteReattemptResult(["a"], true, now);
  assert.equal(tracker.size, 0, "a successful re-attempt removes the id");
});

test("dead-letter: a failed re-attempt backs off (doubling) and is not due until the window elapses", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 4_000_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["a"], now);
  }

  // First re-attempt fails → backoff window = BASE.
  tracker.noteReattemptResult(["a"], false, now);
  assert.deepEqual(
    tracker.takeDueDeadLetters(now, 10),
    [],
    "not due immediately after a failed re-attempt"
  );
  assert.deepEqual(
    tracker.takeDueDeadLetters(now + COMPONENT_DEAD_LETTER_RETRY_BASE_MS, 10),
    ["a"],
    "due once the base backoff window elapses"
  );
});

test("dead-letter: bounded — an id is QUARANTINED after the max re-attempt count and never auto-retried again", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  let now = 5_000_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["a"], now);
  }

  // Fail every re-attempt up to the cap. Each iteration advances the clock past
  // the (growing) backoff window so the id is due, then fails again.
  for (
    let attempt = 0;
    attempt < COMPONENT_DEAD_LETTER_MAX_ATTEMPTS;
    attempt++
  ) {
    now += COMPONENT_DEAD_LETTER_RETRY_MAX_MS; // always past any window
    const due = tracker.takeDueDeadLetters(now, 10);
    assert.deepEqual(
      due,
      ["a"],
      `attempt ${attempt} should still be due before the cap`
    );
    tracker.noteReattemptResult(["a"], false, now);
  }

  // Past the cap: quarantined. Still counted (never hard-dropped) but no longer
  // auto-retried even far in the future.
  assert.equal(
    tracker.size,
    1,
    "a quarantined id is still counted, not dropped"
  );
  now += COMPONENT_DEAD_LETTER_RETRY_MAX_MS * 100;
  assert.deepEqual(
    tracker.takeDueDeadLetters(now, 10),
    [],
    "a quarantined id is never picked for auto-retry again"
  );
  assert.equal(
    tracker.hasDueDeadLetters(now),
    false,
    "no due dead-letters once the only id is quarantined"
  );
});

test("dead-letter: takeDueDeadLetters is bounded by the requested limit", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 6_000_000;
  const ids = Array.from({ length: 10 }, (_, i) => `id-${i}`);
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ids, now);
  }
  assert.equal(tracker.size, ids.length);
  const due = tracker.takeDueDeadLetters(now, 4);
  assert.equal(due.length, 4, "limit caps the returned due set");
});

test("dead-letter: clear() drops all boundary counters and dead-letters (identity change / stop)", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 7_000_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["a", "b"], now);
  }
  assert.ok(tracker.size > 0);
  tracker.clear();
  assert.equal(tracker.size, 0, "clear() empties the dead-letter set");
  // A fresh single failure after clear() must not dead-letter (counter reset).
  const dead = tracker.recordBatchFailure(BOUNDARY, ["a"], now);
  assert.equal(dead, false, "boundary counters were cleared too");
});

test("dead-letter: the in-memory dead-letter set is bounded (oldest evicted at the cap)", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 8_000_000;
  // Dead-letter more distinct ids than the cap; each single-id batch dead-letters
  // once it clears the per-boundary budget on its own distinct boundary.
  const overCap = COMPONENT_MAX_DEAD_LETTERED_IDS + 25;
  for (let i = 0; i < overCap; i++) {
    const boundary = buildComponentBoundaryKey("t", `id-${i}`);
    for (let f = 0; f < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; f++) {
      tracker.recordBatchFailure(boundary, [`id-${i}`], now);
    }
  }
  assert.equal(
    tracker.size,
    COMPONENT_MAX_DEAD_LETTERED_IDS,
    "the dead-letter Map never exceeds its size cap"
  );
});

test("dead-letter durability: deadLetteredIds() snapshots the set and seedDeadLetters re-drives it (cold-restart never-drop)", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 9_000_000;
  // Dead-letter two ids, then quarantine one of them (never auto-retried).
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["a", "b"], now);
  }
  let clock = now;
  for (
    let attempt = 0;
    attempt < COMPONENT_DEAD_LETTER_MAX_ATTEMPTS;
    attempt++
  ) {
    clock += COMPONENT_DEAD_LETTER_RETRY_MAX_MS;
    tracker.noteReattemptResult(["a"], false, clock);
  }
  // "a" is quarantined; the snapshot still includes it (persisted, not dropped).
  const snapshot = tracker.deadLetteredIds().sort();
  assert.deepEqual(snapshot, ["a", "b"], "snapshot includes quarantined ids");

  // Simulate a cold restart: a fresh tracker re-seeded from the durable snapshot.
  const afterRestart = new ComponentSyncDeadLetterTracker();
  afterRestart.seedDeadLetters(snapshot, clock);
  assert.equal(
    afterRestart.size,
    2,
    "re-seeded both dead-letters after restart"
  );
  // Both are due immediately (fresh window) — even the previously-quarantined one
  // is re-driven once, so it is never permanently stranded past the cursor.
  assert.deepEqual(
    afterRestart.takeDueDeadLetters(clock, 10).sort(),
    ["a", "b"],
    "a cold restart re-drives every persisted dead-letter, including the quarantined one"
  );
});

test("dead-letter durability: seedDeadLetters does not reset an already-tracked id's in-flight backoff", () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 10_000_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["a"], now);
  }
  // Fail one re-attempt so "a" is in a backoff window (not due now).
  tracker.noteReattemptResult(["a"], false, now);
  assert.deepEqual(
    tracker.takeDueDeadLetters(now, 10),
    [],
    "in backoff, not due"
  );
  // A live re-seed of the same id must NOT reset it to due-immediately.
  tracker.seedDeadLetters(["a"], now);
  assert.deepEqual(
    tracker.takeDueDeadLetters(now, 10),
    [],
    "re-seeding an already-tracked id preserves its in-flight backoff"
  );
});

test("advanceComponentCursor: persists the current dead-letter ids onto the durable cursor row", () => {
  const persisted: { deadLetteredIds: string[] }[] = [];
  const next = advanceComponentCursor(
    { watermark: null, lastId: null },
    { id: "row-1", last_seen_at: "2026-07-20T10:00:00.000Z" },
    "source-key",
    (_key, state) => {
      persisted.push({ deadLetteredIds: state.deadLetteredIds });
      return undefined;
    },
    ["dead-1", "dead-2"]
  );
  assert.deepEqual(next, {
    watermark: "2026-07-20T10:00:00.000Z",
    lastId: "row-1",
  });
  assert.equal(
    persisted.length,
    1,
    "persist fired once for the cursor advance"
  );
  assert.deepEqual(
    persisted[0].deadLetteredIds,
    ["dead-1", "dead-2"],
    "the durable cursor row carries the current dead-letter ids (ISS-4542)"
  );
});

test("componentDeadLetterRetryDelayMs: doubles per attempt and clamps at the cap", () => {
  assert.equal(
    componentDeadLetterRetryDelayMs(1),
    COMPONENT_DEAD_LETTER_RETRY_BASE_MS
  );
  assert.equal(
    componentDeadLetterRetryDelayMs(2),
    COMPONENT_DEAD_LETTER_RETRY_BASE_MS * 2
  );
  assert.equal(
    componentDeadLetterRetryDelayMs(3),
    COMPONENT_DEAD_LETTER_RETRY_BASE_MS * 4
  );
  // A very large attempt count clamps rather than overflowing to Infinity.
  assert.equal(
    componentDeadLetterRetryDelayMs(1000),
    COMPONENT_DEAD_LETTER_RETRY_MAX_MS
  );
});

test("classifyComponentSyncHttpStatus: 2xx is Accepted", () => {
  for (const status of [200, 201, 202, 204]) {
    assert.equal(
      classifyComponentSyncHttpStatus(status),
      ComponentSyncSendOutcome.Accepted,
      `HTTP ${status} should be Accepted`
    );
  }
});

test("classifyComponentSyncHttpStatus: auth/timeout/rate-limit/5xx and a bare 400 are LaneFailure (never charge the poison budget)", () => {
  // The exact statuses shafty023 called out: 401/403 must NOT walk the inventory
  // forward, 408/429 are transient, and every 5xx is a server-side outage. A bare
  // 400 joins them (shafty023 follow-up): the sync endpoint returns generic 400 for
  // a version-skew `schemaVersion` mismatch that 400s every page, so dead-lettering
  // it would walk the whole inventory forward on one side of the skew.
  for (const status of [400, 401, 403, 408, 429, 500, 502, 503, 504]) {
    assert.equal(
      classifyComponentSyncHttpStatus(status),
      ComponentSyncSendOutcome.LaneFailure,
      `HTTP ${status} should be a LaneFailure`
    );
  }
});

test("classifyComponentSyncHttpStatus: permanent per-batch 4xx are BatchRejected (the only class that dead-letters)", () => {
  for (const status of [409, 413, 422]) {
    assert.equal(
      classifyComponentSyncHttpStatus(status),
      ComponentSyncSendOutcome.BatchRejected,
      `HTTP ${status} should be BatchRejected`
    );
  }
});

/** A no-op transition logger for the recovery-path tests. */
function noopDiag() {
  return { note: () => undefined, set: () => undefined };
}

function resultFor(outcome: ComponentSyncSendOutcome): ComponentSyncSendResult {
  return { outcome, firstUnsentChunkIndex: null, chunkCount: 1 };
}

test("recoverComponentDeadLetters: a LaneFailure re-attempt does NOT advance the row toward quarantine", async () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  // Dead-letter a single id at t0 by exhausting its boundary budget.
  const now = 1_000_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["poison"], now);
  }
  assert.equal(tracker.size, 1, "poison dead-lettered");
  assert.ok(
    tracker.hasDueDeadLetters(now),
    "due immediately after dead-letter"
  );

  // A lane-wide failure during recovery must leave the entry due and NOT advance
  // its backoff — otherwise a transient outage could quarantine a healthy row.
  const ran = await recoverComponentDeadLetters({
    tracker,
    batchLimit: 10,
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => ({ externalId: id, componentKind: "mcp" }))
      ),
    sendComponents: () =>
      Promise.resolve(resultFor(ComponentSyncSendOutcome.LaneFailure)),
    diag: noopDiag(),
    logTag: "test",
  });
  assert.equal(ran, true, "a re-attempt ran");
  assert.equal(tracker.size, 1, "still dead-lettered after the lane failure");
  assert.ok(
    tracker.hasDueDeadLetters(now),
    "STILL due at the same clock — the lane failure did not advance the backoff"
  );
});

test("recoverComponentDeadLetters: a BatchRejected re-attempt advances the bounded backoff", async () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 2_000_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["poison"], now);
  }
  const ran = await recoverComponentDeadLetters({
    tracker,
    batchLimit: 10,
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => ({ externalId: id, componentKind: "mcp" }))
      ),
    sendComponents: () =>
      Promise.resolve(resultFor(ComponentSyncSendOutcome.BatchRejected)),
    diag: noopDiag(),
    logTag: "test",
  });
  assert.equal(ran, true, "a re-attempt ran");
  assert.equal(
    tracker.size,
    1,
    "still dead-lettered after the permanent rejection"
  );
  assert.equal(
    tracker.hasDueDeadLetters(now),
    false,
    "no longer due at the same clock — the permanent rejection pushed the backoff forward"
  );
});

test("recoverComponentDeadLetters: an empty load does NOT drop the dead-letter (DB-unavailable vs confirmed-absent are indistinguishable — never-drop)", async () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 2_500_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["poison"], now);
  }
  assert.equal(tracker.size, 1, "poison dead-lettered");

  // The loader returns [] — which app.ts also does when the DB host is down.
  // The old code dropped the id here (treated it as confirmed deletion); the
  // never-drop invariant requires it to stay queued.
  let sendCalls = 0;
  const ran = await recoverComponentDeadLetters({
    tracker,
    batchLimit: 10,
    loadComponentRows: () => Promise.resolve([]),
    sendComponents: () => {
      sendCalls += 1;
      return Promise.resolve(resultFor(ComponentSyncSendOutcome.Accepted));
    },
    diag: noopDiag(),
    logTag: "test",
  });
  assert.equal(ran, true, "a re-attempt pass ran");
  assert.equal(sendCalls, 0, "no send is attempted for an empty load");
  assert.equal(
    tracker.size,
    1,
    "the dead-letter is STILL queued — an empty load must never drop it"
  );
  assert.ok(
    tracker.hasDueDeadLetters(now),
    "still due (backoff not advanced — the empty load is not the row's fault)"
  );
});

test("recoverComponentDeadLetters: an Accepted re-attempt clears the dead-letter", async () => {
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 3_000_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["poison"], now);
  }
  const ran = await recoverComponentDeadLetters({
    tracker,
    batchLimit: 10,
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => ({ externalId: id, componentKind: "mcp" }))
      ),
    sendComponents: () =>
      Promise.resolve(resultFor(ComponentSyncSendOutcome.Accepted)),
    diag: noopDiag(),
    logTag: "test",
  });
  assert.equal(ran, true, "a re-attempt ran");
  assert.equal(tracker.size, 0, "cleared after the accepted re-attempt");
});

test("recoverComponentDeadLetters: a gate close during the load aborts BEFORE the send (isCurrent re-checked pre-send)", async () => {
  // ISS-4623 (shafty023 review): `isCurrent` folds in the live egress gate +
  // compute target. If it goes false during the `loadComponentRows` await (a
  // policy close / account switch), the recovery must abort BEFORE `sendComponents`
  // — not POST the batch and only skip the outcome recording afterward.
  const tracker = new ComponentSyncDeadLetterTracker();
  const now = 4_000_000;
  for (let i = 0; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    tracker.recordBatchFailure(BOUNDARY, ["poison"], now);
  }
  assert.equal(tracker.size, 1, "poison dead-lettered");

  let current = true;
  let sendCalls = 0;
  const ran = await recoverComponentDeadLetters({
    tracker,
    batchLimit: 10,
    loadComponentRows: (ids) => {
      // The gate closes (policy true→false / target switch) mid-load.
      current = false;
      return Promise.resolve(
        ids.map((id) => ({ externalId: id, componentKind: "mcp" }))
      );
    },
    sendComponents: () => {
      sendCalls += 1;
      return Promise.resolve(resultFor(ComponentSyncSendOutcome.Accepted));
    },
    diag: noopDiag(),
    logTag: "test",
    isCurrent: () => current,
  });
  assert.equal(ran, true, "a pass ran (suppresses the idle transition)");
  assert.equal(
    sendCalls,
    0,
    "no dead-letter batch POSTs once the gate closed during the load"
  );
  assert.equal(
    tracker.size,
    1,
    "the dead-letter stays queued (its backoff was not advanced by an aborted send)"
  );
});

// ISS-5347 (thadeusb review): the module header promised a throwing persist
// observer "cannot escape into the lane's drain", but that only held for the
// Persisted/Failed reports inside the promise chain. The Unavailable report runs
// SYNCHRONOUSLY on `advanceComponentCursor`'s own stack, so a throw there
// propagated out through `applyCursorAdvance` and aborted the lane tick. All
// three paths must now be equally contained.
test("advanceComponentCursor: a throwing observer on the no-persist path cannot escape the advance", () => {
  let observed: ComponentCursorPersistOutcome | null = null;
  const next = advanceComponentCursor(
    { watermark: null, lastId: null },
    { id: "row-1", last_seen_at: "2026-07-20T10:00:00.000Z" },
    "source-key",
    undefined,
    [],
    (outcome) => {
      observed = outcome;
      throw new Error("observer blew up");
    }
  );
  assert.equal(
    observed,
    ComponentCursorPersistOutcome.Unavailable,
    "the synchronous no-persist path still reports the absent durable write"
  );
  assert.deepEqual(
    next,
    { watermark: "2026-07-20T10:00:00.000Z", lastId: "row-1" },
    "the advance still returns the new keyset position after the observer threw"
  );
});

test("advanceComponentCursor: a throwing observer on the rejected-persist path cannot escape the advance", async () => {
  const outcomes: ComponentCursorPersistOutcome[] = [];
  advanceComponentCursor(
    { watermark: null, lastId: null },
    { id: "row-1", last_seen_at: "2026-07-20T10:00:00.000Z" },
    "source-key",
    () => Promise.reject(new Error("db-host exited (code: 0)")),
    [],
    (outcome) => {
      outcomes.push(outcome);
      throw new Error("observer blew up");
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    outcomes,
    [ComponentCursorPersistOutcome.Failed],
    "the rejected persist is reported exactly once even though the observer threw"
  );
});
