/**
 * @file transcript-sync-quiesce.test.ts
 * @description ISS-4903 — the REAL transcript lane, not just the tracker.
 *
 * `TranscriptSyncService.stop()` clears the drain/sweep timers, but a tick
 * already in the air keeps issuing db-host reads and writes. These tests drive
 * the production service and prove `quiesce()` observes that tick: still
 * running after `stop()` (so shutdown cannot claim `clean`), and drained once it
 * actually finishes (so shutdown is not slowed for nothing).
 *
 * Every wait synchronizes on a real completion signal (`deferred`), never a
 * poll loop or a wall-clock sleep (FEA-2399 `test:node` determinism).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { QuiesceOutcome } from "../src/main/lifecycle/sync-lane-quiesce.js";
import {
  deferred,
  fakeExecutor,
  fakeScheduler,
  fakeStore,
  fingerprint,
  flush,
  makeService,
} from "./helpers/transcript-sync-fixtures.js";

/** Budget for the bounded drain under test. */
const BUDGET_MS = 2000;

test("ISS-4903: quiesce reports timed_out while a started drain is still uploading", async () => {
  const scheduler = fakeScheduler();
  const upload = deferred();
  const started = deferred();
  const { service } = makeService({
    store: fakeStore([fingerprint()]),
    scheduler: scheduler.scheduler,
    executor: fakeExecutor({
      syncFile: async () => {
        started.resolve();
        await upload.promise;
        return { kind: "uploaded", caughtUp: true };
      },
    }),
  });

  // `start()` fires the startup sweep + drain as a DETACHED task — exactly the
  // shape that outlived shutdown and failed on the disposed handle.
  service.start();
  await started.promise;

  // The lane's timers are gone, but its in-flight upload is not.
  service.stop();

  assert.equal(
    await service.quiesce(BUDGET_MS, {
      setTimeoutFn: ((callback: () => void) => {
        // Fire the budget immediately: this is the "still running at the
        // deadline" branch, with no wall-clock dependence.
        callback();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeoutFn: (() => undefined) as unknown as typeof clearTimeout,
    }),
    QuiesceOutcome.TimedOut,
    "an upload still in flight after stop() must be reported, not hidden"
  );

  // Let the upload finish so the test leaves nothing in the air.
  upload.resolve();
  await flush();
});

test("ISS-4903: quiesce drains once the in-flight drain completes", async () => {
  const scheduler = fakeScheduler();
  const upload = deferred();
  const started = deferred();
  const { service } = makeService({
    store: fakeStore([fingerprint()]),
    scheduler: scheduler.scheduler,
    executor: fakeExecutor({
      syncFile: async () => {
        started.resolve();
        await upload.promise;
        return { kind: "uploaded", caughtUp: true };
      },
    }),
  });

  service.start();
  await started.promise;
  service.stop();

  const quiescing = service.quiesce(BUDGET_MS);
  // The upload commits — this is the whole point of draining before the db-host
  // goes away rather than tearing it down underneath the write.
  upload.resolve();

  assert.equal(
    await quiescing,
    QuiesceOutcome.Drained,
    "a lane that finishes inside the budget reports drained"
  );
});

test("ISS-4903: an idle lane quiesces immediately (shutdown is not slowed for nothing)", async () => {
  const scheduler = fakeScheduler();
  const { service } = makeService({
    store: fakeStore([]),
    scheduler: scheduler.scheduler,
  });

  service.start();
  await flush();
  service.stop();

  assert.equal(await service.quiesce(BUDGET_MS), QuiesceOutcome.Drained);
});

test("ISS-4903: a lane task that FAILS still drains (a failed tick is finished work)", async () => {
  const scheduler = fakeScheduler();
  const logs: string[] = [];
  const failing = deferred();
  const started = deferred();
  const { service, store } = makeService({
    store: fakeStore([fingerprint()]),
    scheduler: scheduler.scheduler,
    log: (message: string) => {
      logs.push(message);
    },
    executor: fakeExecutor({
      syncFile: async () => {
        started.resolve();
        await failing.promise;
        // The exact failure the ISS-4903 cascade produced, raised from inside a
        // detached tick rather than from the caller's stack.
        throw new Error("db-host exited (code: 0)");
      },
    }),
  });

  service.start();
  await started.promise;
  service.stop();

  const quiescing = service.quiesce(BUDGET_MS);
  failing.resolve();

  assert.equal(
    await quiescing,
    QuiesceOutcome.Drained,
    "a rejected tick has settled; it must not make the lane permanently un-drainable"
  );
  // The failure is NOT swallowed by the drain: the row is still recorded as a
  // failure on the durable retry ladder, so the transcript reaches the cloud on
  // a later attempt rather than being lost to the quiesce.
  assert.ok(
    (store?.failures.length ?? 0) > 0,
    "the failed upload is recorded on the retry ladder, not dropped"
  );
  assert.equal(
    logs.some((line) => line.includes("transcript task error")),
    false,
    "the drain queue handled this failure itself; runDetached only logs strays"
  );
});

/**
 * Timer deps that fire the quiesce budget IMMEDIATELY, so the "still running at
 * the deadline" branch is exercised with no wall-clock dependence.
 */
const immediateBudget = {
  setTimeoutFn: ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout,
  clearTimeoutFn: (() => undefined) as unknown as typeof clearTimeout,
};

test("ISS-4903 (codex review): a user-initiated force-archive is tracked, so quiesce cannot report drained over it", async () => {
  const scheduler = fakeScheduler();
  const revive = deferred();
  const started = deferred();
  const { service, store } = makeService({ scheduler: scheduler.scheduler });
  // `makeService` only returns a null store when the caller passes one; this
  // call does not, so prove the fake exists rather than assuming it.
  if (!store) {
    throw new Error("expected makeService to build a fake store");
  }
  // Hang the force path INSIDE a db-host call — the exact window a user hitting
  // "Sync this transcript anyway" and then quitting lands in. This work reaches
  // the queue directly rather than through `runDetached`, so before ISS-4903 it
  // was invisible to the tracker.
  store.reviveForForcedSync = () => {
    started.resolve();
    return revive.promise.then(() => 0);
  };

  const forced = service.forceSyncOversized("sess-1", "main");
  await started.promise;

  // Timers are gone, but the user's force-archive is not.
  service.stop();

  assert.equal(
    await service.quiesce(BUDGET_MS, immediateBudget),
    QuiesceOutcome.TimedOut,
    "an in-flight force-archive must be reported, not hidden — shutdown would otherwise close the db-host under its next settle and still call itself clean"
  );

  revive.resolve();
  await forced;
  await flush();

  assert.equal(
    await service.quiesce(BUDGET_MS),
    QuiesceOutcome.Drained,
    "and once it finishes the lane drains — the tracker is self-pruning, so a force-archive never wedges shutdown"
  );
});
