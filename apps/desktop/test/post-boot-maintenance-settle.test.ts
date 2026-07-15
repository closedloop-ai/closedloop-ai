/**
 * @file post-boot-maintenance-settle.test.ts
 * @description Regression tests for the Dashboard nav throbber that never
 * cleared. The "initial collector import complete" readiness signal (which
 * drives `DashboardThrobber` via `useDashboardReady()`) is fired from
 * `attachPostBootMaintenanceSettle`. Post-boot maintenance is best-effort
 * background re-derivation, so the signal must settle for the active generation
 * on BOTH success and failure — a rejected maintenance run must not strand the
 * throbber "preparing" forever. Generation/supersede semantics are preserved: a
 * superseded generation must NOT fire (a newer generation owns the signal), and
 * the finalizer always runs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachPostBootMaintenanceSettle } from "../src/main/post-boot-maintenance-settle.js";

test("fires the readiness signal when maintenance resolves for the active generation", async () => {
  const settled: number[] = [];
  const errors: unknown[] = [];
  let finallyCount = 0;

  await attachPostBootMaintenanceSettle(Promise.resolve(), 1, {
    isActive: (gen) => gen === 1,
    onSettleActive: (gen) => settled.push(gen),
    logError: (e) => errors.push(e),
    onFinally: () => {
      finallyCount++;
    },
  });

  assert.deepEqual(settled, [1]);
  assert.equal(errors.length, 0);
  assert.equal(finallyCount, 1);
});

test("STILL fires the readiness signal when maintenance rejects (throbber clears)", async () => {
  const settled: number[] = [];
  const errors: unknown[] = [];
  let finallyCount = 0;
  const failure = new Error("post-boot maintenance boom");

  // Before the fix this promise had no `.catch`: a rejected maintenance run left
  // the readiness signal un-fired forever (throbber stuck) and surfaced an
  // unhandled rejection. attachPostBootMaintenanceSettle must absorb the
  // rejection, log it, and still settle the active generation.
  await attachPostBootMaintenanceSettle(Promise.reject(failure), 7, {
    isActive: (gen) => gen === 7,
    onSettleActive: (gen) => settled.push(gen),
    logError: (e) => errors.push(e),
    onFinally: () => {
      finallyCount++;
    },
  });

  assert.deepEqual(settled, [7], "active generation settles despite rejection");
  assert.deepEqual(errors, [failure], "the failure is logged, not swallowed");
  assert.equal(finallyCount, 1, "finalizer always runs");
});

test("does NOT fire for a superseded generation on success", async () => {
  const settled: number[] = [];
  let finallyCount = 0;

  // isActive returns false: a newer scheduled generation owns the signal now.
  await attachPostBootMaintenanceSettle(Promise.resolve(), 2, {
    isActive: () => false,
    onSettleActive: (gen) => settled.push(gen),
    logError: () => undefined,
    onFinally: () => {
      finallyCount++;
    },
  });

  assert.deepEqual(
    settled,
    [],
    "superseded generation must not fire the signal"
  );
  assert.equal(finallyCount, 1, "finalizer still runs for a superseded run");
});

test("does NOT fire for a superseded generation on rejection, but still logs and finalizes", async () => {
  const settled: number[] = [];
  const errors: unknown[] = [];
  let finallyCount = 0;
  const failure = new Error("superseded boom");

  await attachPostBootMaintenanceSettle(Promise.reject(failure), 3, {
    isActive: () => false,
    onSettleActive: (gen) => settled.push(gen),
    logError: (e) => errors.push(e),
    onFinally: () => {
      finallyCount++;
    },
  });

  assert.deepEqual(
    settled,
    [],
    "superseded generation must not fire the signal"
  );
  assert.deepEqual(errors, [failure], "failure is still logged");
  assert.equal(finallyCount, 1, "finalizer still runs");
});

test("resolves without rejecting even when maintenance rejects (no unhandled rejection)", async () => {
  // The returned promise must resolve (not reject) so the caller's `.finally`
  // chain and cancellation `await task.catch(...)` paths behave, and so the
  // process never sees an unhandled rejection from post-boot maintenance.
  await assert.doesNotReject(() =>
    attachPostBootMaintenanceSettle(Promise.reject(new Error("x")), 1, {
      isActive: () => true,
      onSettleActive: () => undefined,
      logError: () => undefined,
      onFinally: () => undefined,
    })
  );
});
