/**
 * @file write-queue-fairness.test.ts
 * @description ISS-4710 / ISS-4723 PR3 unit coverage for the write queue's
 * TWO-CLASS weighted round-robin (`src/main/database/write-queue.ts`). On a
 * first-boot DATA_REVISION rebuild the desktop store serializes thousands of
 * `bulk` rebuild `$transaction`s through ONE writer queue; before this change the
 * transcript/component lanes' `interactive` writes queued strictly FIFO BEHIND
 * the whole rebuild and uploaded nothing. The scheduler now serves up to K
 * interactive tasks between each bulk task, so interactive work makes steady
 * progress DURING a rebuild — while never starving bulk (one bulk always runs
 * after at most K interactive) and NEVER increasing concurrency (still one task at
 * a time on the single writer connection).
 *
 * Deterministic — every task body is held on an injected deferred and released
 * one at a time; no wall-clock waits. The dispatch ORDER is recorded as each task
 * STARTS, and asserted against the bounded-interleave contract. The cancellation +
 * real-settle-tail invariants are re-asserted so the fairness change did not
 * regress ISS-4572 (those live in `write-queue-cancel.test.ts` too; here we prove
 * they still hold across the two-class scheduler).
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

/** How many interactive tasks the scheduler serves per bulk task (mirrors the
 * production `INTERACTIVE_BURST_PER_BULK`; asserted structurally below, not
 * imported, since it is a private module constant). */
const K = 4;

type HeldTask = {
  label: string;
  release: () => void;
  started: Promise<void>;
};

/**
 * Enqueue a task whose body BLOCKS until released, recording its label into
 * `order` the moment it STARTS running. Returns a handle to release it and a
 * promise that resolves once it has started, so the driver can serialize dispatch.
 */
function enqueueHeld(
  queue: ReturnType<typeof createWriteQueue>,
  order: string[],
  label: string,
  writeClass: (typeof WriteQueueClass)[keyof typeof WriteQueueClass]
): HeldTask {
  const body = deferred<void>();
  const startedSignal = deferred<void>();
  const done = queue.run(
    () => {
      order.push(label);
      startedSignal.resolve();
      return body.promise;
    },
    undefined,
    { class: writeClass }
  );
  done.catch(() => undefined);
  return {
    label,
    release: () => body.resolve(),
    started: startedSignal.promise,
  };
}

/**
 * Drive the single-writer queue deterministically to completion of the whole
 * enqueued set: repeatedly wait for the next task to START (its `fn` body runs on
 * a microtask, so we synchronize on the task's own `started` signal — never a
 * fixed sleep), record its dispatch, then RELEASE it so the scheduler selects the
 * next one. Stops once `stop(order)` is satisfied. Returns having released every
 * task it dispatched. Bounded so a scheduler regression that stalls dispatch fails
 * loudly instead of hanging (per test:node determinism).
 */
async function driveUntil(
  tasks: HeldTask[],
  order: string[],
  stop: (order: string[]) => boolean
): Promise<void> {
  const byLabel = new Map<string, HeldTask>();
  for (const t of tasks) {
    byLabel.set(t.label, t);
  }
  const releasedCount = () => order.length;
  let guard = 0;
  const maxSteps = tasks.length + 5;
  while (!stop(order)) {
    if (guard++ > maxSteps) {
      throw new Error(
        `driveUntil exceeded ${maxSteps} steps — scheduler stalled at order=[${order.join(", ")}]`
      );
    }
    const before = releasedCount();
    // Wait for the next dispatch: race the not-yet-started tasks' `started`
    // signals. Exactly one becomes the running head, records itself, and resolves.
    const pending = tasks.filter((t) => !order.includes(t.label));
    if (pending.length === 0) {
      break;
    }
    await Promise.race(pending.map((t) => t.started));
    // The new head has recorded itself; release it so the writer advances.
    const head = order.at(-1);
    if (!head || order.length === before) {
      throw new Error("expected a new task to have started");
    }
    byLabel.get(head)?.release();
    // Let the release + next selection settle before the next iteration.
    await Promise.resolve();
    await Promise.resolve();
  }
}

test("ISS-4710: interactive tasks are served within K bulk tasks, not starved to the end", async () => {
  const queue = createWriteQueue();
  const order: string[] = [];

  // A long run of bulk (rebuild) writes, all enqueued FIRST — this is the
  // monopolize-the-writer scenario. Then a couple of interactive (transcript /
  // component) writes arrive while the bulk backlog is still pending.
  const bulk: HeldTask[] = [];
  for (let i = 0; i < 12; i += 1) {
    bulk.push(enqueueHeld(queue, order, `bulk-${i}`, WriteQueueClass.Bulk));
  }
  const interactiveA = enqueueHeld(
    queue,
    order,
    "interactive-A",
    WriteQueueClass.Interactive
  );
  const interactiveB = enqueueHeld(
    queue,
    order,
    "interactive-B",
    WriteQueueClass.Interactive
  );

  // Drive the queue until both interactive tasks have STARTED. We never need to
  // release all 12 bulk tasks — the point is the interactive ones are reached
  // early, not starved to the tail behind the whole bulk backlog.
  await driveUntil(
    [...bulk, interactiveA, interactiveB],
    order,
    (o) => o.includes("interactive-A") && o.includes("interactive-B")
  );

  assert.ok(
    order.indexOf("interactive-A") >= 0,
    "interactive-A eventually ran"
  );
  // The two interactive tasks must NOT be starved to the tail: both start before
  // more than K bulk tasks have run. (bulk-0 dispatches first — it is the only
  // ready task at enqueue time — then the interactive burst is served ahead of the
  // remaining bulk backlog.)
  const bulkBeforeSecondInteractive = order
    .slice(0, order.indexOf("interactive-B"))
    .filter((l) => l.startsWith("bulk-")).length;
  assert.ok(
    bulkBeforeSecondInteractive <= K,
    `both interactive tasks served within K=${K} bulk tasks (saw ${bulkBeforeSecondInteractive} bulk before interactive-B)`
  );

  // Drain the rest so the queue settles cleanly (release every remaining held bulk
  // task the driver stopped short of).
  for (const t of bulk) {
    t.release();
  }
  await queue.drain();
});

test("ISS-4710: bulk is never starved — one bulk runs after at most K interactive", async () => {
  const queue = createWriteQueue();
  const order: string[] = [];

  // Many interactive tasks enqueued first, plus one bulk task behind them. The
  // bulk task must NOT be pushed to the very end: it runs after at most K
  // interactive tasks, proving the interleave is BOUNDED (memory safety — bulk
  // rebuild work always makes progress, never indefinitely preempted).
  const interactives: HeldTask[] = [];
  for (let i = 0; i < 12; i += 1) {
    interactives.push(
      enqueueHeld(queue, order, `int-${i}`, WriteQueueClass.Interactive)
    );
  }
  const bulk = enqueueHeld(queue, order, "bulk-0", WriteQueueClass.Bulk);

  await driveUntil([...interactives, bulk], order, (o) => o.includes("bulk-0"));

  const interactiveBeforeBulk = order
    .slice(0, order.indexOf("bulk-0"))
    .filter((l) => l.startsWith("int-")).length;
  assert.ok(
    interactiveBeforeBulk <= K,
    `bulk ran after at most K=${K} interactive tasks (saw ${interactiveBeforeBulk})`
  );

  for (const t of interactives) {
    t.release();
  }
  await queue.drain();
});

test("ISS-4710: a single class runs strictly FIFO when the other class is empty", async () => {
  const queue = createWriteQueue();
  const order: number[] = [];
  // Only interactive work: no bulk to interleave, so plain FIFO.
  const a = queue.run(() => {
    order.push(1);
    return Promise.resolve("a");
  });
  const b = queue.run(() => {
    order.push(2);
    return Promise.resolve("b");
  });
  const c = queue.run(
    () => {
      order.push(3);
      return Promise.resolve("c");
    },
    undefined,
    { class: WriteQueueClass.Bulk }
  );
  assert.equal(await a, "a");
  assert.equal(await b, "b");
  assert.equal(await c, "c");
  assert.deepEqual(order, [1, 2, 3]);
});

test("ISS-4710 (invariant preserved): only ONE task runs at a time across classes", async () => {
  const queue = createWriteQueue();
  let concurrent = 0;
  let maxConcurrent = 0;
  const bodies: ReturnType<typeof deferred<void>>[] = [];

  const makeTask = (
    writeClass: (typeof WriteQueueClass)[keyof typeof WriteQueueClass]
  ): Promise<void> => {
    const body = deferred<void>();
    bodies.push(body);
    return queue.run(
      async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await body.promise;
        concurrent -= 1;
      },
      undefined,
      { class: writeClass }
    );
  };

  const tasks = [
    makeTask(WriteQueueClass.Bulk),
    makeTask(WriteQueueClass.Interactive),
    makeTask(WriteQueueClass.Bulk),
    makeTask(WriteQueueClass.Interactive),
  ];
  // Release each held body in turn; the queue must never let two run at once.
  for (const body of bodies) {
    await Promise.resolve();
    body.resolve();
    await Promise.resolve();
  }
  await Promise.all(tasks);
  assert.equal(
    maxConcurrent,
    1,
    "the two-class scheduler never raises concurrency above one"
  );
});

test("ISS-4710 (@wongk, production loop shape): an interactive sync write completes before the serial rebuild loop finishes", async () => {
  // The scheduler tests above pre-enqueue 12 bulk tasks at once. That is NOT the
  // production shape: `runDataRevisionRebuild` (data-revision-rebuild.ts) AWAITS
  // each `rebuildSessionFromParse` bulk write, then yields through
  // `cooperativeDelay`, THEN submits the next — so the queue never holds the whole
  // rebuild backlog ahead of an interactive write. This test models that real loop
  // and proves the reported stall is fixed: an interactive transcript/component
  // write submitted WHILE the rebuild loop is running completes before the loop
  // does, instead of being starved to the tail behind the whole rebuild.
  const queue = createWriteQueue();
  const order: string[] = [];
  const rebuildSessionCount = 8;

  // A cooperative yield that also lets any queued interactive write run at this
  // boundary — mirrors the real per-session pause between rebuild writes (which is
  // where a concurrently-submitted interactive write gets its turn).
  const cooperativeDelay = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  let interactiveSettled = false;
  let rebuildLoopSettled = false;

  // The interactive hot-path write, submitted just before the rebuild loop starts
  // (i.e. it is already queued while the rebuild is producing bulk tasks).
  const interactive = queue
    .run(
      () => {
        order.push("interactive");
        return Promise.resolve();
      },
      "session-x",
      { class: WriteQueueClass.Interactive }
    )
    .then(() => {
      interactiveSettled = true;
    });

  // The real rebuild loop: submit ONE bulk write, AWAIT it, yield, repeat.
  const rebuildLoop = (async () => {
    for (let i = 0; i < rebuildSessionCount; i += 1) {
      await queue.run(
        () => {
          order.push(`rebuild-${i}`);
          return Promise.resolve();
        },
        undefined,
        { class: WriteQueueClass.Bulk }
      );
      await cooperativeDelay();
    }
  })().then(() => {
    rebuildLoopSettled = true;
  });

  await Promise.all([interactive, rebuildLoop]);
  await queue.drain();

  assert.equal(interactiveSettled, true, "the interactive write ran");
  assert.equal(rebuildLoopSettled, true, "the rebuild loop finished");
  // The load-bearing assertion: the interactive write did NOT wait for the whole
  // rebuild. It runs within the first bulk task's boundary, not after all 8.
  const interactiveIndex = order.indexOf("interactive");
  const lastRebuildIndex = order.lastIndexOf(
    `rebuild-${rebuildSessionCount - 1}`
  );
  assert.ok(
    interactiveIndex >= 0 && interactiveIndex < lastRebuildIndex,
    `interactive completed before the rebuild loop finished (interactive at ${interactiveIndex}, last rebuild at ${lastRebuildIndex}, order=[${order.join(", ")}])`
  );
  // And concretely: it interleaved early — served within K bulk tasks, not at the
  // tail — so a large history no longer strands the sync lanes at "0 bytes".
  const bulkBeforeInteractive = order
    .slice(0, interactiveIndex)
    .filter((l) => l.startsWith("rebuild-")).length;
  assert.ok(
    bulkBeforeInteractive <= K,
    `interactive served within K=${K} rebuild writes (saw ${bulkBeforeInteractive} before it)`
  );
});

test("ISS-4710 (ISS-4572 preserved): cancellation + real-settle tail still hold with the two-class scheduler", async () => {
  const queue = createWriteQueue();
  // A wedged bulk write is evicted by its token; a queued interactive successor
  // must NOT start until the abandoned bulk work truly settles (split-write
  // safety), then it runs and completes.
  const wedgedBulk = deferred<string>();
  let successorStarted = false;
  const successorSignal = deferred<void>();

  const poison = queue.run(() => wedgedBulk.promise, "poison", {
    class: WriteQueueClass.Bulk,
  });
  poison.catch(() => undefined);
  const successor = queue.run(
    () => {
      successorStarted = true;
      successorSignal.resolve();
      return Promise.resolve("ok");
    },
    "successor",
    { class: WriteQueueClass.Interactive }
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    queue.cancel("poison"),
    WriteQueueCancelOutcome.Running,
    "evicted the wedged bulk task, reported as the DISPATCHED head"
  );
  await assert.rejects(poison, (e) => e instanceof WriteQueueCancelledError);

  // The abandoned bulk transaction has not settled — the interactive successor
  // must stay parked (real-settle tail).
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    successorStarted,
    false,
    "successor waits for the abandoned write to truly settle"
  );

  wedgedBulk.resolve("late");
  await successorSignal.promise;
  assert.equal(successorStarted, true, "successor ran after the real settle");
  assert.equal(await successor, "ok");
});
