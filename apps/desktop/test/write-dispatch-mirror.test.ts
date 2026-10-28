/**
 * @file write-dispatch-mirror.test.ts
 * @description ISS-7256 (whitlockk review) — the dispatcher-side mirror of the store
 * thread's write queue.
 *
 * The whole reason this exists is that the store thread cannot answer for its own
 * queue during the window `importSessionBounded` asks about, so every assertion
 * here is about what the mirror can say WITHOUT that thread. The end-to-end proof
 * that the answer actually reaches the bound over the proxy while the store is
 * blocked is `bounded-import-blocked-store.test.ts`; this file pins the state
 * machine that test depends on.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createWriteDispatchMirror,
  WRITE_DISPATCH_MIRROR_MAX_TOKENS,
} from "../src/main/database/db-host/write-dispatch-mirror.js";
import {
  WriteDispatchState,
  WriteQueueTaskPhase,
} from "../src/main/database/write-queue.js";

const SESSION = "session-a";

test("ISS-7256: an unseen token is Absent, never Queued", () => {
  const mirror = createWriteDispatchMirror();
  assert.deepEqual(mirror.probe(SESSION), {
    state: WriteDispatchState.Absent,
    taskSeq: null,
  });
});

test("ISS-7256: a queued-but-undispatched task is readable with no store round trip", () => {
  const mirror = createWriteDispatchMirror();
  mirror.observe(SESSION, WriteQueueTaskPhase.Queued, 7);
  assert.deepEqual(mirror.probe(SESSION), {
    state: WriteDispatchState.Queued,
    taskSeq: 7,
  });
});

test("ISS-7256: a dispatch is recorded, and a later settle does NOT forget it", () => {
  const mirror = createWriteDispatchMirror();
  mirror.observe(SESSION, WriteQueueTaskPhase.Queued, 7);
  mirror.observe(SESSION, WriteQueueTaskPhase.Dispatched, 7);
  mirror.observe(SESSION, WriteQueueTaskPhase.Settled, 7);
  // The session DID hold the writer. Forgetting that the moment its task settled
  // is what would hand it extra deadline windows it has not earned.
  assert.equal(mirror.probe(SESSION).state, WriteDispatchState.Dispatched);
});

test("ISS-7256 (davetho): a same-owner successor is Queued again but carries a NEW taskSeq", () => {
  const mirror = createWriteDispatchMirror();
  mirror.observe(SESSION, WriteQueueTaskPhase.Queued, 7);
  mirror.observe(SESSION, WriteQueueTaskPhase.Dispatched, 7);
  mirror.observe(SESSION, WriteQueueTaskPhase.Settled, 7);
  mirror.observe(SESSION, WriteQueueTaskPhase.Queued, 12);
  assert.deepEqual(mirror.probe(SESSION), {
    state: WriteDispatchState.Queued,
    taskSeq: 12,
  });
});

test("ISS-7256: an out-of-order queued notice cannot downgrade a dispatched task", () => {
  const mirror = createWriteDispatchMirror();
  mirror.observe(SESSION, WriteQueueTaskPhase.Queued, 7);
  mirror.observe(SESSION, WriteQueueTaskPhase.Dispatched, 7);
  // A duplicate/late `queued` for the SAME task. Reading this as a fresh waiter
  // would re-arm a write that is already holding the writer.
  mirror.observe(SESSION, WriteQueueTaskPhase.Queued, 7);
  assert.equal(mirror.probe(SESSION).state, WriteDispatchState.Dispatched);
});

test("ISS-7256: an unrecognised phase records nothing", () => {
  const mirror = createWriteDispatchMirror();
  // The wire check only proves `phase` is a string; inventing a state from one
  // this build does not know is how a corrupt message would reach the bound.
  mirror.observe(SESSION, "not-a-phase" as WriteQueueTaskPhase, 7);
  assert.equal(mirror.probe(SESSION).state, WriteDispatchState.Absent);
  assert.equal(mirror.size(), 0);
});

test("ISS-7256: reset drops everything — the queue died with its thread", () => {
  const mirror = createWriteDispatchMirror();
  mirror.observe(SESSION, WriteQueueTaskPhase.Queued, 7);
  mirror.reset();
  assert.equal(mirror.probe(SESSION).state, WriteDispatchState.Absent);
});

test("ISS-7256: entries age out on the TTL", () => {
  let clock = 1000;
  const mirror = createWriteDispatchMirror({ now: () => clock, ttlMs: 500 });
  mirror.observe(SESSION, WriteQueueTaskPhase.Queued, 7);
  clock += 499;
  mirror.observe("other", WriteQueueTaskPhase.Queued, 8);
  assert.equal(mirror.probe(SESSION).state, WriteDispatchState.Queued);
  clock += 2;
  mirror.observe("other", WriteQueueTaskPhase.Queued, 9);
  assert.equal(
    mirror.probe(SESSION).state,
    WriteDispatchState.Absent,
    "past the TTL the entry is stale evidence and falls back to Absent"
  );
});

test("ISS-7256: retention is capped — the token is an external session id", () => {
  const mirror = createWriteDispatchMirror({ maxTokens: 3, ttlMs: 1_000_000 });
  for (let i = 0; i < 50; i++) {
    mirror.observe(`session-${i}`, WriteQueueTaskPhase.Queued, i);
  }
  assert.equal(mirror.size(), 3, "the map cannot grow with the session corpus");
  assert.equal(
    mirror.probe("session-49").state,
    WriteDispatchState.Queued,
    "the most recent tokens are the ones retained"
  );
  assert.equal(mirror.probe("session-0").state, WriteDispatchState.Absent);
});

test("ISS-7256: the shipped ceiling is finite", () => {
  assert.ok(
    Number.isSafeInteger(WRITE_DISPATCH_MIRROR_MAX_TOKENS) &&
      WRITE_DISPATCH_MIRROR_MAX_TOKENS > 0
  );
});
