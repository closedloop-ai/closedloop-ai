/**
 * @file db-host-fire-and-forget.test.ts
 * @description ISS-6164 — the guard on best-effort db-host writes that have no
 * caller to reject to.
 *
 * The observed failure: `[error-handler] unhandled rejection: db-host exited
 * (code: 0)`. A `void`-launched write was in flight when the db-host child died,
 * nothing caught the rejection `invoke()` minted, and
 * `handleUnhandledRejection` shows the crash dialog and calls `exit(1)`. So a
 * bounce the supervisor recovered from perfectly still took the app down.
 *
 * The two axes pinned here:
 *  - a db-host LIFECYCLE rejection (exit-with-restart, exit-without-restart,
 *    intentional shutdown) is dropped with a log and never propagates;
 *  - anything else still propagates, so a genuine failure in one of these
 *    writes stays exactly as loud as it was before the guard existed.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  dropOnDbHostLifecycleError,
  settleFireAndForgetDbHostError,
} from "../src/main/database/db-host/db-host-fire-and-forget.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";

/** The dropped-write log line names the write, not just the error. */
const DROPPED_WRITE_LABEL = /collection-mode violation/;
/** ...and carries the underlying db-host exit reason. */
const DROPPED_WRITE_REASON = /db-host exited \(code: 0\)/;
/** A genuine store failure, distinct from any db-host lifecycle signature. */
const NON_LIFECYCLE_FAILURE = /UNIQUE constraint failed/;

describe("fire-and-forget db-host writes", () => {
  test("a mid-op host exit with a restart scheduled is dropped, not propagated", () => {
    const logs: string[] = [];
    // Exactly the error handleExit() mints for an op abandoned by the code-0
    // exit ISS-6164 reported, with a replacement fork already armed.
    const exit = new DbHostExitError(0, true, "db-host exited (code: 0)");

    assert.doesNotThrow(() =>
      settleFireAndForgetDbHostError(exit, {
        label: "collection-mode violation",
        log: (message) => logs.push(message),
      })
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0], DROPPED_WRITE_LABEL);
    assert.match(logs[0], DROPPED_WRITE_REASON);
  });

  test("a host exit with NO restart scheduled is also dropped rather than crashing the app", () => {
    // `restartScheduled: false` makes this NON-transient — the supervisor is not
    // bringing the host back. That is a worse situation, but it is still not one
    // a fire-and-forget telemetry write can answer, and crashing the app over it
    // is the ISS-6164 defect. It must be dropped and logged like its sibling.
    const logs: string[] = [];
    const exit = new DbHostExitError(0, false, "db-host exited (code: 0)");

    assert.doesNotThrow(() =>
      settleFireAndForgetDbHostError(exit, {
        label: "pack install run end",
        log: (message) => logs.push(message),
      })
    );
    assert.equal(logs.length, 1);
  });

  test("an intentional shutdown is dropped rather than propagated", () => {
    const logs: string[] = [];
    const shutdown = new DbHostShutdownError(
      DbHostShutdownReason.Exited,
      "db-host exited (code: 0)"
    );

    assert.doesNotThrow(() =>
      settleFireAndForgetDbHostError(shutdown, {
        label: "collection-mode violation",
        log: (message) => logs.push(message),
      })
    );
    assert.equal(logs.length, 1);
  });

  test("an UNTYPED host-exit Error is dropped — handleExit does not always mint a typed class", () => {
    // `DbHostClient.handleExit`'s shutdown branch rejects abandoned ops with a
    // bare `Error(message)` whenever the exit code is NON-graceful, i.e. a
    // signal-numbered crash (5/6/11 — the exit-code-5 RCA) while `closing` is
    // set. That error is neither a DbHostExitError nor a DbHostShutdownError, so
    // a class-only membership test rethrows it and takes the app down — the very
    // failure this guard exists to stop, on the realistic "crashed during
    // teardown" path.
    const logs: string[] = [];

    assert.doesNotThrow(() =>
      settleFireAndForgetDbHostError(new Error("db-host exited (code: 5)"), {
        label: "collection-mode violation",
        log: (message) => logs.push(message),
      })
    );
    assert.equal(logs.length, 1);
  });

  test("a NON-lifecycle failure still propagates, so real bugs stay loud", () => {
    // The guard must narrow the crash to the lifecycle window, not become a
    // blanket catch that hides a genuine SQL/logic failure behind a log line.
    const logs: string[] = [];

    assert.throws(
      () =>
        settleFireAndForgetDbHostError(
          new Error("UNIQUE constraint failed: collection_mode_violation.id"),
          {
            label: "collection-mode violation",
            log: (message) => logs.push(message),
          }
        ),
      NON_LIFECYCLE_FAILURE
    );
    assert.deepEqual(
      logs,
      [],
      "a non-lifecycle failure must not be logged as a dropped write"
    );
  });

  test("the promise wrapper attaches the guard, so a rejected write never goes unhandled", async () => {
    // Drives the production entry point. Without the `.catch` this helper
    // installs, the rejection below reaches the runner as an unhandled
    // rejection and fails this test — which is the crash path ISS-6164 hit in
    // the app.
    const logs: string[] = [];
    dropOnDbHostLifecycleError(
      Promise.reject(new DbHostExitError(0, true, "db-host exited (code: 0)")),
      { label: "collection-mode violation", log: (m) => logs.push(m) }
    );

    await delay(0);
    assert.equal(
      logs.length,
      1,
      "the dropped write must be logged exactly once"
    );
  });
});
