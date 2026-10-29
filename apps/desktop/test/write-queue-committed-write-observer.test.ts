/**
 * @file write-queue-committed-write-observer.test.ts
 * @description ISS-7110 — `withCommittedWriteObserver` in isolation: fires on a
 * committed task, stays silent on a rejected one, and absorbs BOTH failure
 * shapes an `() => void` observer can smuggle in — a synchronous throw and (via
 * structural typing admitting an async function) a rejected returned promise.
 * The promise case matters because the db-host process exits on an unhandled
 * rejection by design (db-host-memory-watchdog.ts), so a floating observer
 * rejection would crash-restart the whole db-host. The store-level integration
 * of this seam is `insights-epoch-committed-writes.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createWriteQueue,
  withCommittedWriteObserver,
} from "../src/main/database/write-queue.js";

test("ISS-7110: notify fires after a committed task and not after a rejected one", async () => {
  const queue = createWriteQueue();
  let notified = 0;
  const observed = withCommittedWriteObserver(queue, () => {
    notified += 1;
  });

  assert.equal(await observed.run(() => Promise.resolve("ok")), "ok");
  assert.equal(notified, 1);

  await assert.rejects(observed.run(() => Promise.reject(new Error("boom"))));
  assert.equal(notified, 1, "a rejected write must not notify");
});

test("ISS-7110: a synchronously throwing notify never fails the committed write", async () => {
  const queue = createWriteQueue();
  const observed = withCommittedWriteObserver(queue, () => {
    throw new Error("observer bug");
  });

  assert.equal(await observed.run(() => Promise.resolve(41)), 41);
});

test("ISS-7110: an async rejecting notify neither fails the write nor floats an unhandled rejection", async () => {
  const queue = createWriteQueue();
  // Structural typing admits a promise-returning function where `() => void`
  // is expected; its rejection must be absorbed, not left to the process-level
  // handler.
  const observed = withCommittedWriteObserver(queue, () =>
    Promise.reject(new Error("async observer bug"))
  );

  const floated: unknown[] = [];
  const capture = (reason: unknown): void => {
    floated.push(reason);
  };
  process.on("unhandledRejection", capture);
  try {
    assert.equal(
      await observed.run(() => Promise.resolve("still ok")),
      "still ok"
    );
    // Unhandled rejections surface on a later tick — give them two.
    await new Promise((resolve) => {
      setImmediate(() => setImmediate(resolve));
    });
    assert.deepEqual(floated, [], "observer rejection must be absorbed");
  } finally {
    process.removeListener("unhandledRejection", capture);
  }
});
