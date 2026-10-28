/**
 * @file db-host-restart-window-interleaving.test.ts
 * @description ISS-8856 — a db-host child that dies while the supervisor is
 * already restarting must neither escape as an unhandled rejection nor leave the
 * ladder wedged.
 *
 * The captured incident is that pair, in that order: an unhandled
 * `db-host exited (code: 1)` reached `handleUnhandledRejection` (which shows the
 * crash dialog and calls `app.exit(1)`), and four seconds later the replacement
 * host exited "while a restart is already in flight" and the retry did not
 * recover. Both halves turn on ONE window — between `scheduleRestart()` arming
 * its timer and the replacement child reporting `Ready` — and inside it the
 * supervisor's own Init handshake is the operation in flight.
 *
 * That window has a second entrance nothing covered. ISS-5715 pinned the
 * replacement that reports `Ready` and THEN exits; this file pins the
 * replacement that exits BEFORE it ever reports `Ready`, which takes a different
 * path entirely — the Init pending entry is still parked, so `handleExit`
 * rejects it, `spawn()`'s promise REJECTS, and recovery rests on the restart
 * attempt's own rejection handler re-arming the ladder. Deleting that single
 * `armRestartTimer(attempt)` call leaves all 176 tests in the 22 suites that
 * construct a `DbHostClient` green while the local store is gone for the rest of
 * the session, so the path was not merely untested — it was invisible.
 *
 * The first exit here carries a NON-ZERO code, as the incident's did. A non-zero
 * code is a crash-signal number rather than a clean stop (see the exit-code-5
 * RCA in `db-host-client.ts`) and is the branch that keeps a plain `Error`
 * instead of the typed shutdown class, so it is the exit shape most likely to
 * reach a consumer that only knows how to classify the graceful one.
 *
 * Timers are INJECTED through the shared harness rather than faked globally, so
 * `setImmediate` stays real — Node needs one real macrotask turn to decide a
 * rejection went unhandled, which is what makes the first assertion possible at
 * all.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type DbHostExitHarness,
  drainMicrotasks,
  startDbHostExitHarness,
} from "./helpers/db-host-exit-harness.js";

/** The rejection `handleExit` mints for the ops that died with the child. */
const EXITED_CODE_1_RE = /db-host exited \(code: 1\)/;
/** The exit code the incident's first host died with. */
const CRASH_EXIT_CODE = 1;
/** The code Electron reports for a replacement killed before it came up. */
const REPLACEMENT_EXIT_CODE = 0;
/** The log line the attempt's own rejection handler mints when it re-arms. */
const RESTART_RETRY_PREFIX = "db-host restart failed";

/** What {@link driveReplacementDiesBeforeReady} observed on its way through. */
type RestartWindowDrive = {
  /** How the in-flight caller op was rejected by the first exit. */
  readonly inFlightRejection: unknown;
  /** Children forked by the time the replacement died. */
  readonly forkedChildren: number;
};

/**
 * Run `body` with the process's `unhandledRejection` listeners replaced by a
 * collector, and return everything that escaped.
 *
 * Asserting on the COLLECTED list rather than on a log line is the point: the
 * subject is "nothing reached the process handler", and a test that only checked
 * for a tidy log would pass while the app still took the crash-dialog exit. Node
 * decides a rejection is unhandled at the end of a macrotask turn, so `body` is
 * followed by a real `setImmediate` hop before the list is read.
 *
 * `body`'s own result is returned alongside, so the caller keeps what the drive
 * observed without smuggling it out through a mutable binding the compiler then
 * has to be told about.
 */
async function collectEscapedRejections<T>(
  body: () => Promise<T>
): Promise<{ escaped: unknown[]; value: T }> {
  const escaped: unknown[] = [];
  const collect = (reason: unknown): void => {
    escaped.push(reason);
  };
  const priorListeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", collect);
  let value: T;
  try {
    value = await body();
    await drainMicrotasks();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.removeListener("unhandledRejection", collect);
    for (const listener of priorListeners) {
      process.on(
        "unhandledRejection",
        listener as (reason: unknown, promise: Promise<unknown>) => void
      );
    }
  }
  return { escaped, value };
}

/**
 * Returns what it observed rather than asserting: each test asserts the
 * preconditions it depends on, so a drive that silently stopped short can never
 * leave a test passing on a scenario it never reached.
 */
async function driveReplacementDiesBeforeReady(
  harness: DbHostExitHarness
): Promise<RestartWindowDrive> {
  const inFlight = harness.client.invoke("sessions.count", []);
  const settledInFlight = inFlight.then(
    () => null,
    (error: unknown) => error
  );
  await harness.settle();

  harness.children[0].exit(CRASH_EXIT_CODE);
  const inFlightRejection = await settledInFlight;

  harness.runRestartBackoff();
  await harness.settle();
  const forkedChildren = harness.children.length;

  harness.children[1]?.exit(REPLACEMENT_EXIT_CODE);
  await harness.settle();

  return { inFlightRejection, forkedChildren };
}

test("a replacement that dies mid-Init does not escape to the process handler", async () => {
  const harness = await startDbHostExitHarness();

  const { escaped, value: drive } = await collectEscapedRejections(() =>
    driveReplacementDiesBeforeReady(harness)
  );

  assert.equal(drive.forkedChildren, 2, "the ladder forked a replacement");
  // Only the restart attempt's own rejection handler arms a SECOND timer, so
  // this establishes that the replacement's death actually produced a rejection
  // and that something handled it. Without it the empty-escape assertion below
  // could not tell "contained" from "there was nothing to contain" — a
  // `handleExit` that stopped rejecting the parked Init entry would leave
  // `spawn()` pending forever and pass for the wrong reason.
  assert.equal(
    harness.armedRestartCount(),
    2,
    `the replacement's death produced a handled spawn rejection; armed ${harness.armedRestartCount()}`
  );
  assert.match(
    String(drive.inFlightRejection),
    EXITED_CODE_1_RE,
    "the caller's own op was rejected by the exit it died on"
  );
  assert.deepEqual(
    escaped,
    [],
    "an exit inside the restart window must not reach handleUnhandledRejection, which shows the crash dialog and exits the app"
  );
});

test("the ladder re-arms when the replacement dies inside the restart window", async () => {
  const harness = await startDbHostExitHarness();

  const drive = await driveReplacementDiesBeforeReady(harness);

  assert.equal(drive.forkedChildren, 2, "the ladder forked a replacement");
  // TWO, not "more than zero": the first exit armed one, and the replacement's
  // death must arm the second. The replacement's own `handleExit` arms nothing —
  // `scheduleRestart()` no-ops on the `restarting` sentinel while this attempt is
  // still in flight — so that second timer can only come from the attempt's own
  // rejection handler. A count read against a pre-drive baseline would be
  // satisfied by the FIRST arm and never notice the missing one.
  assert.equal(
    harness.armedRestartCount(),
    2,
    `the replacement's death armed a second attempt; armed ${harness.armedRestartCount()}`
  );
  assert.ok(
    harness.logs.some((line) => line.startsWith(RESTART_RETRY_PREFIX)),
    `the re-arm is reported, not silent; saw: ${harness.logs.join(" | ")}`
  );
});

test("a call queued across the doubled failure resolves against the healed host", async () => {
  const harness = await startDbHostExitHarness();
  const drive = await driveReplacementDiesBeforeReady(harness);
  assert.equal(drive.forkedChildren, 2, "the ladder forked a replacement");

  // Issued while no host exists at all: it must PARK on `ready` and ride the
  // ladder, not reject `db-host is not running`. This is the user-visible half —
  // the Sessions read path, the collectors and transcript sync all queue here.
  const queued = harness.client.invoke("sessions.count", []);
  harness.runRestartBackoff();
  await harness.settle();
  assert.equal(harness.children.length, 3, "the ladder forked a third child");

  harness.children[2].ready();
  await harness.settle();
  assert.ok(
    harness.children[2].invokedOps().includes("sessions.count"),
    "the queued call reached the healed replacement"
  );
  harness.children[2].resolveLastInvoke(7);
  assert.equal(await queued, 7, "the queued call resolves after healing");
});
