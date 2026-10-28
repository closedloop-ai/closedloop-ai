/**
 * @file db-host-restart-fork-throw.test.ts
 * @description ISS-9013 — a SYNCHRONOUS throw from `utilityProcess.fork` must
 * not escape the restart ladder's backoff timer.
 *
 * `spawn()` forks synchronously and the ladder's `attempt()` is a bare
 * `setTimeout` callback, so a `fork` that THROWS (EMFILE under a crash storm)
 * rather than rejecting left the timer as an uncaughtException: the
 * process-wide handler exited the app, and `restarting` was left true with no
 * timer armed, so the ladder could never re-arm even where the process
 * survived. A rejecting spawn was handled; a throwing one was not, and only the
 * throwing one is this defect — a test that injects a rejection passes against
 * the broken code.
 *
 * The shared harness INJECTS the timer rather than faking it, so the ladder's
 * callback runs on the test's own stack exactly as it runs on the timer's in
 * production: an escaping throw comes back out of `runRestartBackoff()` and
 * reddens the case, which is the observation this suite exists to make. Every
 * assertion is on a COUNT, not on elapsed time.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_DB_HOST_RESTART_ATTEMPTS } from "../src/main/database/db-host/db-host-restart-budget.js";
import type { DbHostExitDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";
import { isRecoverableDbHostExitError } from "../src/shared/db-host-exit-error.js";
import { startDbHostExitHarness } from "./helpers/db-host-exit-harness.js";

/** The shape a real `utilityProcess.fork` raises when the fd table is full. */
const EMFILE_MESSAGE = "spawn EMFILE";
/** The terminal log line, matched on its distinguishing clause. */
const EXHAUSTED_LOG_RE = /restart ladder exhausted after \d+ attempt\(s\)/;
/** The terminal rejection names the op and that nothing is coming back. */
const UNAVAILABLE_RE =
  /db-host is unavailable after \d+ failed restart attempts/;
/** An arbitrary value the recovered child answers an invoke with. */
const RECOVERED_INVOKE_RESULT = 7;

/** Throw an EMFILE-shaped error on the forks `shouldThrow` selects. */
function emfileOn(shouldThrow: (forkCount: number) => boolean) {
  return (forkCount: number): Error | null =>
    shouldThrow(forkCount) ? new Error(EMFILE_MESSAGE) : null;
}

test("a synchronous fork throw during a restart leaves the ladder able to recover", async () => {
  // Only the FIRST replacement throws, so the ladder has somewhere to get to:
  // a case where every fork throws cannot tell "recovered" from "gave up".
  const ladder = await startDbHostExitHarness({
    forkError: emfileOn((forkCount) => forkCount === 2),
  });

  ladder.children[0].exit(1);
  await ladder.settle();
  assert.equal(
    ladder.armedRestartCount(),
    1,
    "the exit armed the ladder's first restart attempt"
  );

  // The throw happens INSIDE this call, on the stack production runs the
  // backoff timer on. Before the fix it came straight back out here.
  ladder.runRestartBackoff();
  await ladder.settle();

  assert.equal(ladder.forkCount(), 2, "the ladder attempted the replacement");
  assert.ok(
    ladder.logs.some((line) => line.includes(EMFILE_MESSAGE)),
    `the throw was reported through the spawn-failure path; saw: ${ladder.logs.join(" | ")}`
  );
  assert.equal(
    ladder.armedRestartCount(),
    2,
    "a further attempt is armed — `restarting` was not left true with no timer"
  );

  ladder.runRestartBackoff();
  await ladder.settle();
  ladder.currentChild().ready();
  await ladder.settle();

  const invoked = ladder.client.invoke("sessions.count", []);
  await ladder.settle();
  ladder.currentChild().resolveLastInvoke(RECOVERED_INVOKE_RESULT);
  assert.equal(
    await invoked,
    RECOVERED_INVOKE_RESULT,
    "the client is serving work again on the replacement child"
  );
});

test("a ladder of synchronous fork throws ends on the monitored exhaustion event", async () => {
  const exhausted: DbHostExitDiagnostics[] = [];
  const ladder = await startDbHostExitHarness({
    forkError: emfileOn((forkCount) => forkCount > 1),
    onRestartExhausted: (event) => exhausted.push(event),
  });

  ladder.children[0].exit(1);
  await ladder.settle();
  // Well past the ceiling: a ladder that kept re-arming would keep forking here.
  for (let round = 0; round < MAX_DB_HOST_RESTART_ATTEMPTS * 3; round++) {
    ladder.runRestartBackoff();
    await ladder.settle();
  }

  assert.equal(
    ladder.forkCount(),
    1 + MAX_DB_HOST_RESTART_ATTEMPTS,
    "the ladder made exactly the ceiling's worth of attempts, then stopped"
  );
  assert.equal(
    exhausted.length,
    1,
    "the terminal state raised the monitored event exactly once"
  );
  assert.equal(
    exhausted[0].restartAttempts,
    MAX_DB_HOST_RESTART_ATTEMPTS,
    "the monitored event reports how many attempts were actually made"
  );
  assert.ok(
    ladder.logs.some((line) => EXHAUSTED_LOG_RE.test(line)),
    `the ladder reported giving up; saw: ${ladder.logs.join(" | ")}`
  );

  const rejection = await ladder.client.invoke("sessions.count", []).then(
    () => null,
    (error: unknown) => error
  );
  // `isRecoverableDbHostExitError(null)` is also false, so the resolve case has
  // to be excluded before that check means anything.
  assert.ok(
    rejection instanceof Error,
    "the call rejected rather than resolved"
  );
  assert.match(rejection.message, UNAVAILABLE_RE);
  assert.equal(
    isRecoverableDbHostExitError(rejection),
    false,
    "work after exhaustion is refused as unrecoverable, not left pending"
  );
});
