/**
 * @file agent-session-sync-tick-failure-log.test.ts
 * @description ISS-7980 — the shared sync-tick logger owns both the local line
 * and the reportability verdict used by monitored Desktop exception telemetry.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { logSyncTickFailure } from "../src/main/agent-sync/agent-session-sync-tick-failure-log.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";

const TAG = "component-invocation-sync";

afterEach(() => {
  gatewayLog.clear();
  gatewayLog.setVerbose(false);
});

test("a graceful db-host shutdown logs debug and is not reportable", () => {
  gatewayLog.setVerbose(true);
  gatewayLog.clear();

  const reportable = logSyncTickFailure(
    TAG,
    new DbHostShutdownError(
      DbHostShutdownReason.Exited,
      "db-host exited (code: 0)"
    )
  );

  assert.equal(reportable, false);
  assert.deepEqual(
    gatewayLog
      .getEntries()
      .filter((entry) => entry.tag === TAG)
      .map((entry) => `${entry.level}: ${entry.message}`),
    ["info: sync abandoned: db-host shutting down (retries on next launch)"]
  );
});

test("a db-host the supervisor gave up restarting is abandoned, not re-warned every tick", () => {
  gatewayLog.setVerbose(true);
  gatewayLog.clear();

  // ISS-8776: the restart ladder's terminal state. Every read this lane makes
  // rejects identically on every 5 s tick for the rest of the session, so
  // reporting it as a fresh failure buries the ONE monitored report of the
  // terminal condition under a repeat of itself.
  const reportable = logSyncTickFailure(
    TAG,
    new DbHostExitError(
      1,
      false,
      "db-host is unavailable after 8 failed restart attempts (op: sessions.count)"
    )
  );

  assert.equal(reportable, false);
  assert.deepEqual(
    gatewayLog
      .getEntries()
      .filter((entry) => entry.tag === TAG)
      .map((entry) => `${entry.level}: ${entry.message}`),
    [
      "info: sync abandoned: db-host is unavailable and will not restart (retries on next launch)",
    ]
  );
});

test("a db-host exit with a restart IN FLIGHT is still a reportable failure", () => {
  gatewayLog.clear();

  // The discriminator is `restartScheduled`, not "is it a db-host exit". A
  // bounce with a replacement coming is the transient case this lane has always
  // warned about, and quietening it would hide a real crash storm.
  const reportable = logSyncTickFailure(
    TAG,
    new DbHostExitError(1, true, "db-host exited (code: 1)")
  );

  assert.equal(reportable, true);
  assert.deepEqual(
    gatewayLog
      .getEntries()
      .filter((entry) => entry.tag === TAG)
      .map((entry) => `${entry.level}: ${entry.message}`),
    ["warn: sync failed: db-host exited (code: 1)"]
  );
});

test("a genuine tick failure warns and is reportable", () => {
  gatewayLog.clear();

  const reportable = logSyncTickFailure(
    TAG,
    new Error("promotion transaction rejected")
  );

  assert.equal(reportable, true);
  assert.deepEqual(
    gatewayLog
      .getEntries()
      .filter((entry) => entry.tag === TAG)
      .map((entry) => `${entry.level}: ${entry.message}`),
    ["warn: sync failed: promotion transaction rejected"]
  );
});
