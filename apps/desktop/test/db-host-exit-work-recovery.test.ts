/**
 * @file db-host-exit-work-recovery.test.ts
 * @description ISS-5808 — an unexpected db-host exit must not silently destroy
 * the work that was in flight.
 *
 * ISS-5715/#4708 fixed the SUPERVISOR (a replacement child is always forked).
 * This suite covers the half it did not: the abandoned ops themselves. It drives
 * the shared fault-injection harness — one fixture, every consumer — and asserts
 * the four properties the live captures on 2026-08-10 violated:
 *
 *  1. an exit rejects in-flight ops with a CLASSIFIABLE error carrying whether a
 *     replacement is actually coming;
 *  2. it produces zero unhandled rejections;
 *  3. recovery is real — a later call succeeds against the replacement child;
 *  4. a re-drive is bounded by ATTEMPT COUNT and terminates.
 *
 * Plus the discrimination ISS-5262/ISS-4903 established and this ticket must not
 * regress: an exit inside the intentional-teardown window is NOT this fault.
 *
 * No wall-clock waits: the harness injects the timer and fires the restart
 * backoff synchronously, so every bound is asserted as a count.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DB_HOST_EXIT_MAX_ATTEMPTS,
  redriveOnDbHostExit,
} from "../src/main/database/db-host/db-host-exit-redrive.js";
import {
  DbHostExitError,
  findDbHostExitError,
  isRecoverableDbHostExitError,
} from "../src/shared/db-host-exit-error.js";
import { DbHostShutdownError } from "../src/shared/db-host-shutdown-error.js";
import { startDbHostExitHarness } from "./helpers/db-host-exit-harness.js";

/** The exit code both live captures reported — a clean, deliberate teardown. */
const CLEAN_EXIT_CODE = 0;
/** A failure the classifier must never mistake for a host exit. */
const QUERY_FAILURE_RE = /no such column/;
/** SIGTRAP, the exit code a native crash reports (see the RCA in db-host-client). */
const CRASH_SIGNAL_EXIT_CODE = 5;

test("an in-flight op abandoned by a clean host exit rejects with a classifiable, recoverable error", async () => {
  const harness = await startDbHostExitHarness();
  const inFlight = harness.client.invoke("dashboard.getInsights", []);
  await harness.settle();

  harness.currentChild().exit(CLEAN_EXIT_CODE);

  const error = await inFlight.then(
    () => null,
    (rejection: unknown) => rejection
  );
  assert.ok(
    error instanceof DbHostExitError,
    "the abandoned op must reject with the typed exit error, not a bare Error"
  );
  // The message is deliberately UNCHANGED, so installed builds and existing
  // suites still see the string they always saw.
  assert.equal(error.message, "db-host exited (code: 0)");
  assert.equal(error.exitCode, CLEAN_EXIT_CODE);
  assert.equal(
    error.restartScheduled,
    true,
    "the supervisor armed a replacement fork, so the error must say so"
  );
  assert.equal(isRecoverableDbHostExitError(error), true);
});

test("a clean host exit produces no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const harness = await startDbHostExitHarness();
    // Three concurrent reads, exactly the `get-insights` shape from the second
    // capture: all in flight, all abandoned by the same exit. Only the CALLER's
    // promises get a handler — nothing here attaches one to the client's own
    // internal bookkeeping, so an internally-dropped rejection surfaces.
    const reads = [
      harness.client.invoke("dashboard.getInsights", ["delivery"]),
      harness.client.invoke("dashboard.getInsights", ["utilization"]),
      harness.client.invoke("dashboard.getInsights", ["agents"]),
    ].map((read) => read.catch(() => undefined));
    await harness.settle();
    harness.currentChild().exit(CLEAN_EXIT_CODE);
    // Drive the replacement through the Ready-then-exit window too: that is the
    // path whose Init handshake and re-armed `ready` promise nobody outside the
    // client ever awaits.
    harness.runRestartBackoff();
    await harness.settle();
    harness.currentChild().ready();
    harness.currentChild().exit(CLEAN_EXIT_CODE);
    await Promise.all(reads);
    await harness.settle();
    // unhandledRejection is reported on a macrotask boundary, not a microtask
    // one, so yield past one before reading the tally.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(
    unhandled,
    [],
    "both live captures ended in [unhandled-rejection]; a host exit must produce none"
  );
});

test("recovery is real: a call issued after the exit succeeds against the replacement child", async () => {
  const harness = await startDbHostExitHarness();
  const abandoned = harness.client.invoke("sessions.count", []);
  await harness.settle();
  harness.currentChild().exit(CLEAN_EXIT_CODE);
  await assert.rejects(abandoned);
  await harness.settle();

  // A caller that arrives while the replacement is still coming must QUEUE, not
  // fail — `ready` stays pending across the whole ladder.
  const afterExit = harness.client.invoke("sessions.count", []);
  harness.runRestartBackoff();
  await harness.settle();
  harness.currentChild().ready();
  await harness.settle();
  harness.currentChild().resolveLastInvoke(7);

  assert.equal(await afterExit, 7);
  assert.equal(
    harness.children.length,
    2,
    "exactly one replacement child should have been forked"
  );
});

test("a re-driven read is replayed against the replacement child and succeeds", async () => {
  const harness = await startDbHostExitHarness();
  let attempts = 0;
  const read = redriveOnDbHostExit(
    () => {
      attempts++;
      return harness.client.invoke("dashboard.getInsights", ["delivery"]);
    },
    { label: "db ipc read" }
  );
  await harness.settle();
  harness.currentChild().exit(CLEAN_EXIT_CODE);
  await harness.settle();

  harness.runRestartBackoff();
  await harness.settle();
  harness.currentChild().ready();
  await harness.settle();
  harness.currentChild().resolveLastInvoke({ ok: true });

  assert.deepEqual(await read, { ok: true });
  assert.equal(attempts, 2, "one original attempt plus exactly one re-drive");
  assert.deepEqual(
    harness.currentChild().invokedOps(),
    ["dashboard.getInsights"],
    "the re-drive must reach the REPLACEMENT child, not the dead one"
  );
});

test("the re-drive is bounded by attempt count and rethrows once exhausted", async () => {
  let attempts = 0;
  const exit = new DbHostExitError(
    CLEAN_EXIT_CODE,
    true,
    "db-host exited (code: 0)"
  );
  const logs: string[] = [];
  await assert.rejects(
    redriveOnDbHostExit(
      () => {
        attempts++;
        return Promise.reject(exit);
      },
      { label: "insights", log: (message) => logs.push(message) }
    ),
    (error: unknown) => error === exit
  );
  assert.equal(
    attempts,
    DB_HOST_EXIT_MAX_ATTEMPTS,
    "a host that keeps dying must not be retried without bound"
  );
  assert.equal(logs.length, DB_HOST_EXIT_MAX_ATTEMPTS - 1);
});

test("an exit with no replacement coming is not re-driven at all", async () => {
  let attempts = 0;
  const wedged = new DbHostExitError(
    CLEAN_EXIT_CODE,
    false,
    "db-host exited (code: 0)"
  );
  await assert.rejects(
    redriveOnDbHostExit(
      () => {
        attempts++;
        return Promise.reject(wedged);
      },
      { label: "insights" }
    ),
    (error: unknown) => error === wedged
  );
  assert.equal(
    attempts,
    1,
    "re-driving against a host nobody is restarting is a storm, not a recovery"
  );
});

test("a genuine query failure is never re-driven", async () => {
  let attempts = 0;
  await assert.rejects(
    redriveOnDbHostExit(
      () => {
        attempts++;
        return Promise.reject(new Error("no such column: nope"));
      },
      { label: "insights" }
    ),
    QUERY_FAILURE_RE
  );
  assert.equal(attempts, 1);
});

test("an exit inside the intentional-teardown window stays a shutdown, not a fault", async () => {
  const harness = await startDbHostExitHarness();
  const inFlight = harness.client.invoke("sessions.count", []);
  await harness.settle();

  harness.client.beginClosing();
  harness.currentChild().exit(CLEAN_EXIT_CODE);

  const error = await inFlight.then(
    () => null,
    (rejection: unknown) => rejection
  );
  assert.ok(
    error instanceof DbHostShutdownError,
    "a quit must not be reported as a crash"
  );
  assert.equal(
    findDbHostExitError(error),
    null,
    "and it must not be re-drivable — there is no host to re-drive against"
  );
  assert.equal(
    harness.children.length,
    1,
    "no replacement may be forked mid-shutdown"
  );
});

test("a wrapped rethrow keeps the exit classifiable through its cause", () => {
  const exit = new DbHostExitError(
    CLEAN_EXIT_CODE,
    true,
    "db-host exited (code: 0)"
  );
  const sanitized = new Error("LOCAL_BRANCHES_SOURCE_TRANSIENT", {
    cause: exit,
  });
  assert.equal(findDbHostExitError(sanitized), exit);
  assert.equal(isRecoverableDbHostExitError(sanitized), true);
  assert.equal(
    isRecoverableDbHostExitError(new Error("LOCAL_BRANCHES_SOURCE_TRANSIENT")),
    false,
    "a boundary that DISCARDS the cause must not be mistaken for one that keeps it"
  );
});

/**
 * Deeper than `MAX_CAUSE_DEPTH` (3, i.e. four links walked). Built as plain
 * `Error`s so the walk is stopped by the DEPTH bound, not by the
 * not-an-Error guard.
 */
const OVER_DEPTH_CAUSE_LINKS = 5;

test("the cause walk is bounded: an exit buried deeper than the limit is not classified", () => {
  const exit = new DbHostExitError(
    CLEAN_EXIT_CODE,
    true,
    "db-host exited (code: 0)"
  );
  let wrapped: Error = exit;
  for (let link = 0; link < OVER_DEPTH_CAUSE_LINKS; link++) {
    wrapped = new Error(`wrapper ${link}`, { cause: wrapped });
  }
  assert.equal(
    findDbHostExitError(wrapped),
    null,
    "the bound must fail CLOSED — an unbounded walk over a caller-supplied cause chain is the thing it exists to prevent"
  );
  assert.equal(isRecoverableDbHostExitError(wrapped), false);
});

test("a CYCLIC cause chain terminates instead of spinning", () => {
  const outer = new Error("outer");
  const inner = new Error("inner", { cause: outer });
  // `cause` is caller-supplied, so nothing stops it pointing back up. Without
  // the depth bound this walk never returns.
  outer.cause = inner;
  assert.equal(findDbHostExitError(outer), null);
});

test("a CRASH-code exit inside the shutdown window is never re-driven", async () => {
  const harness = await startDbHostExitHarness();
  const inFlight = harness.client.invoke("sessions.count", []);
  await harness.settle();

  // The ambiguous cell of the matrix: `closing` is set, but the code is a crash
  // SIGNAL number (SIGTRAP → 5), so `isGracefulDbHostExitCode` is false and
  // `handleExit` keeps a plain Error — neither a shutdown nor a typed exit. It
  // must fail CLOSED: nothing is bringing a host back during teardown, so a
  // re-drive here would spin against a corpse.
  harness.client.beginClosing();
  harness.currentChild().exit(CRASH_SIGNAL_EXIT_CODE);

  const error = await inFlight.then(
    () => null,
    (rejection: unknown) => rejection
  );
  assert.equal(isRecoverableDbHostExitError(error), false);
  assert.equal(findDbHostExitError(error), null);
  assert.equal(harness.children.length, 1);
});
