/**
 * @file write-queue-cancel.test.ts
 * @description ISS-4572 unit coverage for the write queue's TASK-SCOPED eviction
 * (`src/main/database/write-queue.ts`). The desktop store serializes every
 * `prisma.write` through ONE queue shared across the five concurrent boot-import
 * loops; a genuinely-wedged historical import write (accepted but never
 * completing) would park every later source behind it. `cancel(token)` evicts the
 * task OWNED by that token so the tail advances and later queued writes dispatch,
 * while the evicted caller's promise rejects and the wedged work is abandoned.
 *
 * These tests pin the R2 redesign contract with injected completion signals — no
 * wall-clock waits:
 *   - FIFO ordering is preserved with no eviction;
 *   - a wedged task is evicted BY ITS TOKEN so a queued task runs;
 *   - WRONG-VICTIM regression: `cancel` never evicts a DIFFERENT owner's running
 *     head (the core R2 corruption);
 *   - SPLIT-WRITE regression: the successor does not start until the evicted
 *     task's underlying work has truly settled (no interleave on the writer);
 *   - `cancel` is a no-op for an unknown/absent token;
 *   - an untagged task is never evictable;
 *   - a late settle of an evicted task neither re-settles it nor takes a victim.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWriteQueue,
  WriteQueueCancelledError,
  WriteQueueCancelOutcome,
  WriteQueueClass,
} from "../src/main/database/write-queue.js";
import { deferred } from "./deferred.js";

test("ISS-4572: without eviction, tasks run FIFO and each result is returned", async () => {
  const queue = createWriteQueue();
  const order: number[] = [];
  const a = queue.run(() => {
    order.push(1);
    return Promise.resolve("a");
  }, "a");
  const b = queue.run(() => {
    order.push(2);
    return Promise.resolve("b");
  }, "b");
  assert.equal(await a, "a");
  assert.equal(await b, "b");
  assert.deepEqual(order, [1, 2]);
});

test("ISS-4572: a wedged task is evicted BY ITS TOKEN so the NEXT queued write proceeds (not parked)", async () => {
  const queue = createWriteQueue();
  // The first (poison) source's write is accepted but never completes.
  const wedged = deferred<string>();
  let laterRan = false;
  const laterCompleted = deferred<void>();

  const poison = queue.run(() => wedged.promise, "poison-session");
  poison.catch(() => undefined);

  // A later source's write is queued BEHIND the wedged one. It must not run until
  // the wedged task is evicted.
  const later = queue.run(() => {
    laterRan = true;
    laterCompleted.resolve();
    return Promise.resolve("later");
  }, "later-session");

  // Let the microtask chain settle: the poison task is at the head and running;
  // the later task is queued and MUST NOT have run yet.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(laterRan, false, "the later write is parked behind the wedge");

  // Evict the poison session's OWN task — the tail advances and the later write
  // dispatches once the abandoned work drains (see the split-write test).
  const evicted = queue.cancel("poison-session");
  assert.equal(
    evicted,
    WriteQueueCancelOutcome.Running,
    "the wedged task was evicted by its token, and reported as the DISPATCHED head"
  );
  await assert.rejects(poison, (e) => e instanceof WriteQueueCancelledError);

  // The abandoned wedged write must finish for the tail to advance (split-write
  // safety); resolve it, then the later source proceeds.
  wedged.resolve("abandoned-but-settles");
  await laterCompleted.promise;
  assert.equal(laterRan, true, "the later write ran after eviction");
  assert.equal(await later, "later");
});

test("ISS-4572 (WRONG-VICTIM regression): cancel never evicts a DIFFERENT owner's running head", async () => {
  const queue = createWriteQueue();
  // A HEALTHY session's write is at the running head; a second, unrelated session
  // times out and calls cancel(itsOwnId). The healthy head must NOT be evicted —
  // this is the core R2 corruption (evicting the wrong session's transaction).
  const healthyBody = deferred<string>();
  let healthyRejected = false;
  const healthy = queue.run(() => healthyBody.promise, "healthy-session");
  healthy.catch(() => {
    healthyRejected = true;
  });

  await Promise.resolve();
  // The timed-out session has NO task on the queue (its parse never enqueued a
  // write, or its own write already settled). cancel must be a no-op.
  const evicted = queue.cancel("timed-out-session");
  assert.equal(
    evicted,
    WriteQueueCancelOutcome.None,
    "cancel for a non-owner token evicts nothing — no wrong victim"
  );

  // The healthy head is untouched and completes normally.
  healthyBody.resolve("healthy");
  assert.equal(await healthy, "healthy");
  assert.equal(healthyRejected, false, "the healthy head was never rejected");
});

test("ISS-4572 (SPLIT-WRITE regression): the successor does not start until the evicted task's work truly settles", async () => {
  const queue = createWriteQueue();
  // The wedged task models an interactive transaction on the single writer
  // connection. Even after eviction (caller rejected), the successor must NOT open
  // its own transaction until the abandoned one actually finishes — otherwise a
  // delete-then-reinsert could interleave / split-write on the shared connection.
  const wedgedTxn = deferred<string>();
  let successorStarted = false;
  const successorStartedSignal = deferred<void>();

  const wedged = queue.run(() => wedgedTxn.promise, "wedged");
  wedged.catch(() => undefined);
  const successor = queue.run(() => {
    successorStarted = true;
    successorStartedSignal.resolve();
    return Promise.resolve("successor");
  }, "successor");

  await Promise.resolve();
  await Promise.resolve();

  // Evict the wedged task. The CALLER rejects immediately...
  assert.equal(queue.cancel("wedged"), WriteQueueCancelOutcome.Running);
  await assert.rejects(wedged, (e) => e instanceof WriteQueueCancelledError);

  // ...but the successor must still be parked, because the abandoned transaction
  // has NOT settled yet. It cannot open a transaction on the writer connection
  // while the prior one may still be mid-flight.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    successorStarted,
    false,
    "the successor waits for the abandoned transaction to truly settle"
  );

  // The abandoned transaction finally finishes; only NOW may the successor run.
  wedgedTxn.resolve("done-late");
  await successorStartedSignal.promise;
  assert.equal(
    successorStarted,
    true,
    "the successor ran after the real settle"
  );
  assert.equal(await successor, "successor");
});

test("ISS-4572: cancel is a no-op for an unknown token (nothing to evict)", () => {
  const queue = createWriteQueue();
  assert.equal(
    queue.cancel("nobody"),
    WriteQueueCancelOutcome.None,
    "no task owned by this token"
  );
});

test("ISS-4572: an untagged task is never evictable", async () => {
  const queue = createWriteQueue();
  const body = deferred<string>();
  const untagged = queue.run(() => body.promise); // no token
  await Promise.resolve();
  // Even the untagged running head cannot be targeted — cancel needs a matching
  // token, so a live hook / maintenance write is safe from eviction.
  assert.equal(
    queue.cancel("anything"),
    WriteQueueCancelOutcome.None,
    "untagged task is invisible"
  );
  body.resolve("ok");
  assert.equal(await untagged, "ok");
});

test("ISS-4572: a not-yet-running queued task is evictable by token before it dispatches", async () => {
  const queue = createWriteQueue();
  const headBody = deferred<string>();
  let queuedRan = false;

  const head = queue.run(() => headBody.promise, "head");
  const queued = queue.run(() => {
    queuedRan = true;
    return Promise.resolve("queued");
  }, "queued-session");
  queued.catch(() => undefined);

  await Promise.resolve();
  // Evict the QUEUED (not-yet-running) task by its token while the head runs.
  // ISS-6115: a never-dispatched task reports QUEUED, which is what tells
  // `importSessionBounded` the owner only ever waited behind someone else.
  assert.equal(queue.cancel("queued-session"), WriteQueueCancelOutcome.Queued);
  await assert.rejects(queued, (e) => e instanceof WriteQueueCancelledError);

  // Its fn must never run (it was evicted before dispatch).
  headBody.resolve("head");
  assert.equal(await head, "head");
  await queue.drain();
  assert.equal(queuedRan, false, "an evicted queued task never runs its fn");
});

test("ISS-4572: cancel uses a custom reason when supplied", async () => {
  const queue = createWriteQueue();
  const wedged = deferred<string>();
  const reason = new Error("evicted after 2m");
  const poison = queue.run(() => wedged.promise, "poison");
  await Promise.resolve();
  queue.cancel("poison", reason);
  await assert.rejects(poison, (e) => e === reason);
  wedged.resolve("late");
});

test("ISS-4572: a late settle of an evicted task neither re-settles it nor takes a later victim", async () => {
  const queue = createWriteQueue();
  const wedged = deferred<string>();
  const secondStarted = deferred<void>();
  const secondBody = deferred<string>();

  const first = queue.run(() => wedged.promise, "first");
  first.catch(() => undefined);
  const second = queue.run(() => {
    secondStarted.resolve();
    return secondBody.promise;
  }, "second");

  await Promise.resolve();
  assert.equal(queue.cancel("first"), WriteQueueCancelOutcome.Running);
  await assert.rejects(first, (e) => e instanceof WriteQueueCancelledError);

  // The abandoned first task settles late; the tail advances and the second runs.
  wedged.resolve("ignored-late");
  await secondStarted.promise;
  // A stale cancel for the already-settled first token is a no-op — it must not
  // take the now-running second as victim.
  assert.equal(
    queue.cancel("first"),
    WriteQueueCancelOutcome.None,
    "no re-eviction of a settled task"
  );
  secondBody.resolve("second");
  assert.equal(await second, "second");
});

test("ISS-4710 (@wongk, global-order): cancel evicts the OLDER bulk task, not a newer same-token interactive one", async () => {
  // Two-class regression: `cancel` must select by GLOBAL enqueue order, not
  // interactive-first. A token owns an OLDER bulk task (the wedged historical
  // import write) and a NEWER interactive task. Concatenating the interactive
  // queue first would evict the newer interactive one — the wrong victim — and
  // leave the actual wedge in place. Selection by `seq` evicts the older bulk one.
  const queue = createWriteQueue();
  // A different session occupies the running head so both of the token's tasks
  // stay QUEUED (not dispatched) when cancel runs.
  const headBody = deferred<string>();
  const head = queue.run(() => headBody.promise, "other-session");
  head.catch(() => undefined);
  await Promise.resolve();

  const olderBulk = queue.run(() => Promise.resolve("older-bulk"), "victim", {
    class: WriteQueueClass.Bulk,
  });
  olderBulk.catch(() => undefined);
  const newerInteractive = queue.run(
    () => Promise.resolve("newer-interactive"),
    "victim",
    { class: WriteQueueClass.Interactive }
  );

  assert.equal(
    queue.cancel("victim"),
    WriteQueueCancelOutcome.Queued,
    "a victim task was evicted, and it had never dispatched"
  );
  // The OLDER bulk task is the one evicted; the newer interactive survives.
  await assert.rejects(
    olderBulk,
    (e) => e instanceof WriteQueueCancelledError,
    "the older bulk task (global-earliest) was the victim"
  );
  // Drain the rest cleanly: release the head so the surviving interactive runs.
  headBody.resolve("head-done");
  assert.equal(
    await newerInteractive,
    "newer-interactive",
    "the newer same-token interactive task was NOT evicted"
  );
  await queue.drain();
});

test("ISS-4710 (@wongk, global-order): cancel evicts the RUNNING wedge over a newer queued same-token task", async () => {
  // The classic wedge: the timed-out write is the one HOLDING the writer (the
  // running head), and a newer same-token task is queued behind it. A queued-wins
  // selection would evict the newer queued task and leave the wedge running. By
  // global `seq`, the older running head is the victim.
  const queue = createWriteQueue();
  const wedged = deferred<string>();
  const runningWedge = queue.run(() => wedged.promise, "victim", {
    class: WriteQueueClass.Bulk,
  });
  runningWedge.catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();

  // A newer same-token task queued behind the running wedge.
  const newerQueued = queue.run(() => Promise.resolve("newer"), "victim", {
    class: WriteQueueClass.Interactive,
  });
  newerQueued.catch(() => undefined);

  assert.equal(
    queue.cancel("victim"),
    WriteQueueCancelOutcome.Running,
    "a victim was evicted, and it was the DISPATCHED head"
  );
  await assert.rejects(
    runningWedge,
    (e) => e instanceof WriteQueueCancelledError,
    "the running wedge (global-earliest) was cancelled, not the newer queued task"
  );
  // Split-write safety: the abandoned wedge must truly settle before the newer
  // task runs; then it completes normally (never evicted).
  wedged.resolve("abandoned-settles");
  assert.equal(await newerQueued, "newer", "the newer queued task survived");
  await queue.drain();
});
