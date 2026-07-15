/**
 * @file db-host-memory-watchdog.test.ts
 * @description FEA-3072 — the db-host heap instrumentation must (a) name a heavy
 * op in the log without changing its result/throw behavior, and (b) emit a
 * single HEAP PRESSURE line on the rising edge of a warn-threshold crossing and
 * stop cleanly. This guards the diagnostics we're relying on to finally locate
 * the recurring exit-code-5 OOM: if `measureOp` swallowed a throw or the
 * watchdog spammed/misfired, the signal would be worse than none.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  installProcessCrashLogging,
  measureOp,
  startHeapWatchdog,
} from "../src/main/database/db-host/db-host-memory-watchdog.js";

const GET_INSIGHTS_OP_LOG = /db-host op "dashboard\.getInsights" heap/;
const GET_ALL_OP_LOG = /db-host op "sessions\.getAll"/;
const BOOM_ERROR = /boom/;
const UNCAUGHT_LOG = /uncaughtException: Error: kaboom/;
const UNHANDLED_LOG = /unhandledRejection: Error: rej/;

test("measureOp returns the run() value and logs when heap exceeds warn", async () => {
  const logs: string[] = [];
  // warnHeapBytes: 0 forces the "heap above warn" branch deterministically
  // (heapUsed is always ≥ 0), so the op is always named regardless of delta.
  const value = await measureOp(
    "dashboard.getInsights",
    (m) => logs.push(m),
    () => Promise.resolve(42),
    {
      warnHeapBytes: 0,
    }
  );
  assert.equal(value, 42);
  assert.equal(logs.length, 1);
  assert.match(logs[0], GET_INSIGHTS_OP_LOG);
});

test("measureOp rethrows the op error and still logs in finally", async () => {
  const logs: string[] = [];
  await assert.rejects(
    measureOp(
      "sessions.getAll",
      (m) => logs.push(m),
      () => Promise.reject(new Error("boom")),
      {
        warnHeapBytes: 0,
      }
    ),
    BOOM_ERROR
  );
  // The finally-block measurement must run even when the op throws.
  assert.equal(logs.length, 1);
  assert.match(logs[0], GET_ALL_OP_LOG);
});

test("measureOp stays silent for a cheap op under threshold", async () => {
  const logs: string[] = [];
  const value = await measureOp(
    "cheap.op",
    (m) => logs.push(m),
    () => Promise.resolve("ok"),
    {
      // Both thresholds unreachable → no log.
      opDeltaWarnBytes: Number.MAX_SAFE_INTEGER,
      warnHeapBytes: Number.MAX_SAFE_INTEGER,
    }
  );
  assert.equal(value, "ok");
  assert.equal(logs.length, 0);
});

test("installProcessCrashLogging logs AND exits so the worker restarts", () => {
  const logs: string[] = [];
  const exitCodes: number[] = [];
  // Snapshot pre-existing listeners so we only invoke + clean up ours (node:test
  // registers its own uncaughtException listener).
  const beforeUncaught = new Set(process.listeners("uncaughtException"));
  const beforeRejection = new Set(process.listeners("unhandledRejection"));
  try {
    installProcessCrashLogging(
      (m) => logs.push(m),
      (code) => exitCodes.push(code)
    );
    const [uncaught] = process
      .listeners("uncaughtException")
      .filter((l) => !beforeUncaught.has(l));
    const [rejection] = process
      .listeners("unhandledRejection")
      .filter((l) => !beforeRejection.has(l));
    assert.ok(uncaught, "uncaughtException handler registered");
    assert.ok(rejection, "unhandledRejection handler registered");

    uncaught(new Error("kaboom"), "uncaughtException");
    rejection(new Error("rej"), Promise.resolve());

    // Must exit(1) on BOTH — otherwise the listener suppresses Node's default
    // crash and the DbHostClient supervisor never restarts the wedged worker.
    assert.deepEqual(exitCodes, [1, 1]);
    assert.equal(logs.length, 2);
    assert.match(logs[0], UNCAUGHT_LOG);
    assert.match(logs[1], UNHANDLED_LOG);
  } finally {
    for (const l of process
      .listeners("uncaughtException")
      .filter((l) => !beforeUncaught.has(l))) {
      process.removeListener("uncaughtException", l);
    }
    for (const l of process
      .listeners("unhandledRejection")
      .filter((l) => !beforeRejection.has(l))) {
      process.removeListener("unhandledRejection", l);
    }
  }
});

test("startHeapWatchdog logs HEAP PRESSURE once on the rising edge, then stops", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const logs: string[] = [];
    // warnHeapBytes: 1 → heapUsed is always over the threshold, so the first
    // sample crosses; subsequent samples must NOT re-log (rising-edge only).
    const watchdog = startHeapWatchdog({
      log: (m) => logs.push(m),
      warnHeapBytes: 1,
      sampleIntervalMs: 1000,
    });
    mock.timers.tick(1000);
    mock.timers.tick(1000);
    mock.timers.tick(1000);
    const pressureLines = logs.filter((l) => l.includes("HEAP PRESSURE"));
    assert.equal(pressureLines.length, 1);

    watchdog.stop();
    mock.timers.tick(1000);
    assert.equal(logs.filter((l) => l.includes("HEAP PRESSURE")).length, 1);
  } finally {
    mock.timers.reset();
  }
});
