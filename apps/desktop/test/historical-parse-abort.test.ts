/**
 * @file historical-parse-abort.test.ts
 * @description ISS-4444: the utility-process parser runner can ABORT the current
 * parse turn (`abortInFlightParse`) so a CPU-spinning parser stops pegging a core
 * after the manager's per-source parse watchdog gave up. Aborting rejects the
 * in-flight job (its promise settles) and kills the worker; the NEXT parseSource
 * lazily spawns a fresh worker. A no-op when no worker is active.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createUtilityProcessHistoricalParseRunner } from "../src/main/collectors/engine/utility-process-historical-parse-runner.js";
import { Harness } from "../src/main/collectors/types.js";

const ABORTED_PATTERN = /aborted/;
const STOPPED_BEFORE_DISPATCH_PATTERN = /stopped before dispatch/;

/** Minimal fake utility process (mirrors the worker-protocol suite's fake). */
class FakeUtilityProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly messages: Array<{ requestId: string }> = [];
  killed = false;

  postMessage(message: { requestId: string }): void {
    this.messages.push(message);
  }

  kill(): void {
    this.killed = true;
    this.emit("exit", 0);
  }
}

test("ISS-4444: abortInFlightParse rejects the in-flight parse and kills the worker", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });

  const pending = runner.parseSource(Harness.Claude, "/tmp/poison.jsonl");
  // Dispatch is serialized (ISS-4444 codex P1): the fork runs on the chained
  // microtask, so flush it before grabbing the child.
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];
  assert.ok(child);
  assert.equal(child.killed, false);

  // The parse turn wedges (the fake never emits a response). The manager's
  // per-source watchdog fires and aborts it.
  runner.abortInFlightParse();

  await assert.rejects(pending, ABORTED_PATTERN);
  assert.equal(child.killed, true, "the wedged worker was killed");

  // The runner stays reusable: the next parse spawns a FRESH worker. Swallow its
  // rejection — stop() below rejects the in-flight job, and an unhandled rejection
  // after the test ends would fail the run. Dispatch is serialized (ISS-4444
  // codex P1), so the fork happens on the chained microtask, not synchronously;
  // let the chain flush before asserting the fresh worker exists.
  const next = runner.parseSource(Harness.Claude, "/tmp/next.jsonl");
  next.catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    children.length,
    2,
    "a fresh worker was spawned after the abort"
  );
  runner.stop();
  await assert.rejects(next);
});

test("ISS-4444: concurrent parseSource calls are serialized so an abort discards only the timed-out request", async () => {
  // The shared runner backs all five concurrent boot-import harness loops.
  // Killing the child rejects every request pending on it, so if two sources
  // were dispatched at once, aborting a poison parse would also discard the
  // healthy one and its manager would silently skip a good source. Serialized
  // dispatch guarantees at most one request is in flight, so the healthy source
  // never reaches the worker until the poison one has settled.
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });

  // Two harness loops dispatch at once. Only the first should reach the worker.
  const poison = runner.parseSource(Harness.Claude, "/tmp/poison.jsonl");
  poison.catch(() => undefined);
  const healthy = runner.parseSource(Harness.Codex, "/tmp/healthy.jsonl");
  healthy.catch(() => undefined);

  // Flush the dispatch chain's leading microtask so the first turn posts.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(children.length, 1, "only one worker child was spawned");
  const child = children[0];
  assert.ok(child);
  assert.equal(
    child.messages.length,
    1,
    "only the first request was posted to the worker (the second is queued)"
  );
  assert.equal(child.messages[0]?.requestId, "historical-parse-1");

  // The poison parse wedges and is aborted. This kills the child, but the healthy
  // request was NEVER dispatched to it, so it cannot be discarded by the kill.
  runner.abortInFlightParse();
  await assert.rejects(poison, ABORTED_PATTERN);
  assert.equal(child.killed, true);

  // The healthy request now dispatches on a FRESH worker and can still succeed.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    children.length,
    2,
    "the queued healthy parse spawned a fresh worker"
  );
  const fresh = children[1];
  assert.ok(fresh);
  assert.equal(
    fresh.messages.length,
    1,
    "the healthy request reached the fresh worker"
  );

  runner.stop();
  await assert.rejects(healthy);
});

test("ISS-4444: abortInFlightParse is a safe no-op when no worker is active", () => {
  const runner = createUtilityProcessHistoricalParseRunner({
    forkWorker: () => new FakeUtilityProcess(),
  });
  // No parseSource yet → no child. Must not throw.
  assert.doesNotThrow(() => runner.abortInFlightParse());
  runner.stop();
});

test("ISS-4572 (shafty023 / wongk review): stop() invalidates a turn queued behind the dispatch tail so it does NOT fork a worker after shutdown", async () => {
  // A first turn holds the serialized dispatch tail; a second turn is enqueued
  // BEHIND it (chained on the tail, not yet dispatched). `stop()` then tears the
  // runner down. Without the generation guard the queued second turn would run
  // `dispatchParse` once the tail advances and fork a FRESH worker AFTER shutdown,
  // running a full parse window ahead of any restarted generation. It must reject
  // instead — and spawn no new worker.
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });

  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl");
  first.catch(() => undefined);
  // Enqueue the second turn while the first still holds the tail (its worker has
  // not responded, so the tail has not advanced).
  const queued = runner.parseSource(Harness.Codex, "/tmp/queued.jsonl");
  queued.catch(() => undefined);

  // Flush the leading microtask so ONLY the first turn dispatches.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(children.length, 1, "only the first turn spawned a worker");

  // Tear down. This rejects the dispatched first turn and kills its worker; the
  // queued second turn must reject on dispatch, not fork a worker.
  runner.stop();
  await assert.rejects(first);
  await assert.rejects(queued, STOPPED_BEFORE_DISPATCH_PATTERN);

  // Let the dispatch chain fully drain — the stale queued turn must NOT have
  // spawned a second worker after shutdown.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    children.length,
    1,
    "no worker was forked for the queued turn after stop()"
  );

  // The runner stays reusable: a parseSource after stop starts a fresh generation
  // and dispatches normally on a new worker.
  const afterStop = runner.parseSource(Harness.Claude, "/tmp/after.jsonl");
  afterStop.catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    children.length,
    2,
    "a parseSource after stop() dispatches on a fresh worker"
  );
  runner.stop();
  await assert.rejects(afterStop);
});

test("ISS-4572 (wongk review): the second real runner turn dispatches (fires onDispatch) only AFTER the first settles", async () => {
  // Pins the PRODUCTION serialized-dispatch contract that the fake runner in
  // `ingest-parse-dispatch-deadline.test.ts` stands in for: two real
  // `parseSource` turns share ONE worker, and the second's `onDispatch` (the
  // deadline-arming signal) must not fire until the first has fully settled. A
  // regression that dispatched both at once — or fired the second's onDispatch
  // early — would break the dispatch-scoped deadline this PR relies on.
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });

  const dispatchOrder: string[] = [];
  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl", () =>
    dispatchOrder.push("first")
  );
  first.catch(() => undefined);
  const second = runner.parseSource(Harness.Codex, "/tmp/second.jsonl", () =>
    dispatchOrder.push("second")
  );
  second.catch(() => undefined);

  await Promise.resolve();
  await Promise.resolve();
  // Only the first turn has dispatched; the second is queued and its onDispatch
  // has NOT fired yet.
  assert.deepEqual(
    dispatchOrder,
    ["first"],
    "only the first turn armed its deadline; the queued second has not"
  );
  assert.equal(children.length, 1, "one shared worker so far");

  // Settle the first turn: abort it so the serialized tail advances and the second
  // turn dispatches on a fresh worker.
  runner.abortInFlightParse();
  await assert.rejects(first, ABORTED_PATTERN);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    dispatchOrder,
    ["first", "second"],
    "the second turn's onDispatch fired only after the first settled"
  );
  assert.equal(children.length, 2, "the second turn spawned its own worker");

  runner.stop();
  await assert.rejects(second);
});
