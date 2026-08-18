/**
 * @file crash-telemetry-flush.test.ts
 * @description ISS-6328 — the crash handlers must drain telemetry before exit.
 *
 * Production ships app exceptions through Batch processors (~5s delay), and the
 * crash handlers emit and then call `app.exit()`, which skips `before-quit` and
 * so drains nothing. The result was that Datadog received zero crash events
 * fleet-wide: the event was emitted into a batch that never left the process.
 *
 * These tests drive the real `handleUncaughtException` /
 * `handleUnhandledRejection` and assert the ORDER — flush strictly before exit
 * — plus the time cap that keeps a wedged transport from turning a crash into a
 * hang. Timers are faked; nothing here reads a real clock.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  handleUncaughtException,
  handleUnhandledRejection,
} from "../src/main/lifecycle/error-handlers.js";
import { createProcessExceptionTelemetryBridge } from "../src/main/telemetry/process-exception-telemetry-bridge.js";
import { OBSERVABILITY_SHUTDOWN_DEADLINE_MS } from "../src/main/telemetry/shutdown-deadline.js";

type CrashRun = {
  order: string[];
  exits: number[];
  deps: {
    emitException: (error: unknown) => void;
    flushTelemetry: () => Promise<void>;
    log: (msg: string) => void;
    exit: (code: number) => void;
    showDialog: (title: string, body: string) => void;
  };
};

function createCrashRun(flush: () => Promise<void>): CrashRun {
  const order: string[] = [];
  const exits: number[] = [];
  return {
    order,
    exits,
    deps: {
      emitException: () => order.push("emit"),
      flushTelemetry: () => {
        order.push("flush");
        return flush();
      },
      log: () => undefined,
      exit: (code) => {
        order.push("exit");
        exits.push(code);
      },
      showDialog: () => order.push("dialog"),
    },
  };
}

test("an uncaught exception flushes telemetry before it exits", async () => {
  let flushResolved = false;
  const run = createCrashRun(async () => {
    // A real flush is not instantaneous; resolve on a later microtask so an
    // implementation that merely CALLS flush without awaiting it would exit
    // with `flushResolved` still false.
    await Promise.resolve();
    flushResolved = true;
  });

  await handleUncaughtException(new Error("boom"), run.deps);

  assert.deepEqual(run.order, ["emit", "dialog", "flush", "exit"]);
  assert.ok(
    flushResolved,
    "the flush must have SETTLED before exit was called"
  );
  assert.deepEqual(run.exits, [1]);
});

test("an unhandled Error rejection flushes telemetry before it exits", async () => {
  let flushResolved = false;
  const run = createCrashRun(async () => {
    await Promise.resolve();
    flushResolved = true;
  });

  await handleUnhandledRejection(new Error("boom"), run.deps);

  assert.deepEqual(run.order, ["emit", "dialog", "flush", "exit"]);
  assert.ok(
    flushResolved,
    "the flush must have SETTLED before exit was called"
  );
  assert.deepEqual(run.exits, [1]);
});

test("a non-Error rejection flushes even though it does not exit", async () => {
  // This branch keeps the app running, so the emitted event would otherwise sit
  // in the batch until some unrelated export happened to carry it.
  const run = createCrashRun(() => Promise.resolve());

  await handleUnhandledRejection("plain string reason", run.deps);

  assert.deepEqual(run.order, ["emit", "flush"]);
  assert.deepEqual(run.exits, [], "this branch must not exit");
});

test("a never-resolving flush is capped and still exits (ISS-6328)", async () => {
  // The whole reason the cap exists: a wedged relay socket must not convert a
  // crash into a hang. Fake timers so this asserts the cap, not the wall clock.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const run = createCrashRun(() => new Promise<void>(() => undefined));

    const handled = handleUncaughtException(new Error("boom"), run.deps);
    await Promise.resolve();
    assert.deepEqual(
      run.exits,
      [],
      "exit must not happen while the flush is still pending"
    );

    mock.timers.tick(OBSERVABILITY_SHUTDOWN_DEADLINE_MS);
    await handled;

    assert.deepEqual(run.order, ["emit", "dialog", "flush", "exit"]);
    assert.deepEqual(run.exits, [1], "the deadline must release the exit");
  } finally {
    mock.timers.reset();
  }
});

test("a rejected flush does not stop the crash path", async () => {
  const run = createCrashRun(() => Promise.reject(new Error("relay wedged")));

  await handleUncaughtException(new Error("boom"), run.deps);

  assert.deepEqual(run.order, ["emit", "dialog", "flush", "exit"]);
  assert.deepEqual(run.exits, [1]);
});

test("a handler with no flush dependency still exits", async () => {
  // Pre-init crashes have no runtime bound, so `flushTelemetry` is absent.
  const order: string[] = [];
  const exits: number[] = [];

  await handleUncaughtException(new Error("boom"), {
    emitException: () => order.push("emit"),
    log: () => undefined,
    exit: (code) => {
      order.push("exit");
      exits.push(code);
    },
    showDialog: () => order.push("dialog"),
  });

  assert.deepEqual(order, ["emit", "dialog", "exit"]);
  assert.deepEqual(exits, [1]);
});

test("the bridge flushes through the bound runtime, and no-ops without one", async () => {
  // Production wiring: startup passes `processExceptionTelemetryBridge
  // .flushTelemetry` as the handler's flush, so this proves the crash path
  // reaches the runtime rather than a local stub.
  const bridge = createProcessExceptionTelemetryBridge();

  // Unbound (pre-init): resolves without waiting on anything.
  await bridge.flushTelemetry();

  const flush = mock.fn(() => Promise.resolve());
  bridge.bindRuntime({
    start: () => Promise.resolve(),
    emitAppLifecycleEvent: () => undefined,
    emitAppExceptionEvent: () => undefined,
    emitIpcPerfEvent: () => undefined,
    emitSyncBatchEvent: () => undefined,
    emitImportHealthEvent: () => undefined,
    flush,
    shutdown: () => Promise.resolve(),
    getBufferedRecords: () => [],
    resetBuffer: () => undefined,
    exportExternalRecords: () => ({
      ok: true,
      acceptedRecords: 0,
      droppedRecordsCount: 0,
    }),
  });

  await bridge.flushTelemetry();
  assert.equal(flush.mock.calls.length, 1);

  bridge.clearRuntime();
  await bridge.flushTelemetry();
  assert.equal(
    flush.mock.calls.length,
    1,
    "a cleared runtime must not be flushed again"
  );
});
