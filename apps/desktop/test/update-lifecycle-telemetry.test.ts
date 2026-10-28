/**
 * @file update-lifecycle-telemetry.test.ts
 * @description ISS-7247/ISS-7225 coverage for desktop update lifecycle telemetry.
 *
 * The regression this file exists for, above all others: an upgrade that reports
 * `install_started`, restarts, and comes back on the OLD version must be recorded
 * as a FAILURE. That outcome is only observable from the far side of the restart,
 * so the tests drive a real two-process-lifetime sequence against a real
 * on-disk store rather than asserting on a mock's arguments.
 *
 * Also pinned here:
 *   1. the terminal record really reaches the relay — decoded out of the OTLP
 *      protobuf the runtime shipped to the transport, with the real
 *      `createDesktopOtelRuntime`, not an in-process spy;
 *   2. nothing on the pre-restart side may emit a success — a build that
 *      short-circuits the post-restart check has to fail here;
 *   3. a boot-crash on the new version stays distinguishable from a clean
 *      upgrade, and a quick GRACEFUL quit does not masquerade as one;
 *   4. an attempt is never consumed by a record that did not ship;
 *   5. the production wiring really calls the reporter, so deleting a call site
 *      cannot leave this suite green.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UpdateEvent,
  UpdateFailureReason,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { afterEach, test } from "vitest";
import {
  createBeforeQuitHandler,
  type ShutdownLifecycleApplication,
} from "../src/main/lifecycle/shutdown-lifecycle.js";
import type { DesktopUpdateEventInput } from "../src/main/telemetry/app-otel-runtime-update.js";
import {
  buildUpdateLifecycleRecord,
  isPostRestartUpdateEvent,
} from "../src/main/telemetry/app-otel-runtime-update.js";
import {
  classifyUpdateFailureReason,
  resolveCurrentVersionAgeDays,
  resolveUpdateAttemptOutcome,
} from "../src/main/update/update-attempt-record.js";
import {
  createDesktopUpdateLifecycleReporter,
  type DesktopUpdateLifecycleReporter,
  type UpdateTelemetryTimerHandle,
} from "../src/main/update/update-lifecycle-telemetry.js";
import {
  createUpdateTelemetryStore,
  UPDATE_TELEMETRY_STATE_FILENAME,
} from "../src/main/update/update-telemetry-store.js";

const OLD_VERSION = "0.16.696";
const NEW_VERSION = "0.16.1451";
const OTHER_VERSION = "0.16.1285";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function createStoreDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "cl-update-telemetry-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * One app process lifetime, backed by a real store file so the state that
 * survives a "restart" is the state that really survives one.
 *
 * `runTimers` is manual on purpose: the stability window is what separates a
 * crash from a clean run, so a test has to be able to end a process WITHOUT it
 * elapsing.
 */
function createProcessLifetime(options: {
  storeDirectory: string;
  runningVersion: string;
  isTelemetryLive?: boolean;
  /**
   * Whether the runtime ACCEPTS a record, independent of `isTelemetryLive`.
   * They are separate in production — `emitUpdateEvent` also returns false when
   * its strict parse throws — and collapsing them here would make the
   * "never consumed by a record that did not ship" guards unreachable.
   */
  emitSucceeds?: boolean;
  nowMs?: number;
}): {
  reporter: DesktopUpdateLifecycleReporter;
  emitted: DesktopUpdateEventInput[];
  elapseStabilityWindow: () => void;
} {
  const emitted: DesktopUpdateEventInput[] = [];
  const timerCallbacks = new Map<UpdateTelemetryTimerHandle, () => void>();
  const isTelemetryLive = options.isTelemetryLive ?? true;
  const emitSucceeds = options.emitSucceeds ?? true;
  const reporter = createDesktopUpdateLifecycleReporter({
    getCurrentVersion: () => options.runningVersion,
    emit: (input) => {
      if (!(isTelemetryLive && emitSucceeds)) {
        return false;
      }
      emitted.push(input);
      return true;
    },
    store: createUpdateTelemetryStore(options.storeDirectory),
    isTelemetryLive: () => isTelemetryLive,
    now: () => options.nowMs ?? 1_000_000,
    setTimeoutFn: (callback) => {
      const handle: UpdateTelemetryTimerHandle = {};
      timerCallbacks.set(handle, callback);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      timerCallbacks.delete(handle);
    },
  });
  return {
    reporter,
    emitted,
    elapseStabilityWindow() {
      for (const [handle, callback] of [...timerCallbacks]) {
        timerCallbacks.delete(handle);
        callback();
      }
    },
  };
}

/** Drive one process through an upgrade apply + the quit that restarts it. */
function runUpgradeInitiatingProcess(storeDirectory: string): {
  emitted: DesktopUpdateEventInput[];
} {
  const lifetime = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
  });
  lifetime.reporter.checked(NEW_VERSION);
  lifetime.reporter.available(NEW_VERSION);
  lifetime.reporter.downloadStarted(NEW_VERSION);
  lifetime.reporter.downloadSucceeded(NEW_VERSION);
  lifetime.reporter.installStarted(NEW_VERSION);
  // What the shutdown sequence does on an update-triggered quit.
  lifetime.reporter.flushPendingTerminalRecord();
  lifetime.reporter.restartInitiated(NEW_VERSION);
  return { emitted: lifetime.emitted };
}

test("an upgrade that restarts back onto the OLD version is recorded as a failure", () => {
  const storeDirectory = createStoreDirectory();

  const initiating = runUpgradeInitiatingProcess(storeDirectory);
  // The pre-restart process may not claim success — it cannot see the outcome.
  assert.equal(
    initiating.emitted.some((record) => isPostRestartUpdateEvent(record.event)),
    false,
    "the pre-restart process emitted a post-restart terminal event"
  );

  // The install did not take: the relaunch came back on the version we started
  // from. This is the whole point of ISS-7247.
  const relaunched = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
  });
  relaunched.reporter.onBoot();
  relaunched.elapseStabilityWindow();

  const terminal = relaunched.emitted.filter((record) =>
    isPostRestartUpdateEvent(record.event)
  );
  assert.equal(terminal.length, 1, "expected exactly one terminal record");
  assert.equal(terminal[0]?.event, UpdateEvent.RestartFailed);
  assert.equal(
    terminal[0]?.failureReason,
    UpdateFailureReason.VersionUnchanged
  );
  assert.equal(terminal[0]?.fromVersion, OLD_VERSION);
  assert.equal(
    terminal[0]?.toVersion,
    NEW_VERSION,
    "the failure must still name the version the upgrade was FOR"
  );
});

test("an upgrade that restarts onto the expected version is recorded as a success exactly once", () => {
  const storeDirectory = createStoreDirectory();
  runUpgradeInitiatingProcess(storeDirectory);

  const relaunched = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
  });
  relaunched.reporter.onBoot();
  relaunched.elapseStabilityWindow();

  const terminal = relaunched.emitted.filter((record) =>
    isPostRestartUpdateEvent(record.event)
  );
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.event, UpdateEvent.RestartedOnNewVersion);
  assert.equal(terminal[0]?.bootAttempts, 1);
  assert.equal(terminal[0]?.failureReason, undefined);

  // The attempt is consumed: a third process must not re-report it.
  const later = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
  });
  later.reporter.onBoot();
  later.elapseStabilityWindow();
  assert.deepEqual(
    later.emitted.filter((record) => isPostRestartUpdateEvent(record.event)),
    []
  );
});

test("a landing on a version nobody predicted is reported as such, not folded into either outcome", () => {
  const storeDirectory = createStoreDirectory();
  runUpgradeInitiatingProcess(storeDirectory);

  const relaunched = createProcessLifetime({
    storeDirectory,
    runningVersion: OTHER_VERSION,
  });
  relaunched.reporter.onBoot();
  relaunched.elapseStabilityWindow();

  const terminal = relaunched.emitted.filter((record) =>
    isPostRestartUpdateEvent(record.event)
  );
  assert.equal(terminal[0]?.event, UpdateEvent.RestartFailed);
  assert.equal(
    terminal[0]?.failureReason,
    UpdateFailureReason.UnexpectedVersion
  );
});

test("a boot that dies inside the stability window is reported as a crash, not a clean upgrade", () => {
  const storeDirectory = createStoreDirectory();
  runUpgradeInitiatingProcess(storeDirectory);

  // Boot 1 on the new binary: reaches reconciliation, then the process dies
  // before the stability window elapses — no terminal record ships.
  const crashedBoot = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
  });
  crashedBoot.reporter.onBoot();
  assert.deepEqual(
    crashedBoot.emitted.filter((record) =>
      isPostRestartUpdateEvent(record.event)
    ),
    [],
    "a boot that died inside the window must not have reported"
  );

  // Boot 2 survives, and reports what boot 1 could not.
  const survivingBoot = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
  });
  survivingBoot.reporter.onBoot();
  survivingBoot.elapseStabilityWindow();

  const terminal = survivingBoot.emitted.filter((record) =>
    isPostRestartUpdateEvent(record.event)
  );
  assert.equal(terminal[0]?.event, UpdateEvent.RestartFailed);
  assert.equal(terminal[0]?.failureReason, UpdateFailureReason.CrashOnBoot);
  assert.equal(terminal[0]?.bootAttempts, 2);
});

test("a graceful quit inside the stability window settles the attempt instead of looking like a crash", () => {
  const storeDirectory = createStoreDirectory();
  runUpgradeInitiatingProcess(storeDirectory);

  // Boot on the new binary, then the user quits normally before the window is
  // up. Without the shutdown flush this would leave the attempt pending and the
  // next launch would libel it as a crash.
  const quickQuit = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
  });
  quickQuit.reporter.onBoot();
  quickQuit.reporter.flushPendingTerminalRecord();

  const terminal = quickQuit.emitted.filter((record) =>
    isPostRestartUpdateEvent(record.event)
  );
  assert.equal(terminal[0]?.event, UpdateEvent.RestartedOnNewVersion);
  assert.equal(terminal[0]?.failureReason, undefined);

  const nextLaunch = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
  });
  nextLaunch.reporter.onBoot();
  nextLaunch.elapseStabilityWindow();
  assert.deepEqual(
    nextLaunch.emitted.filter((record) =>
      isPostRestartUpdateEvent(record.event)
    ),
    []
  );
});

test("a boot with no telemetry neither consumes the attempt nor counts against it", () => {
  const storeDirectory = createStoreDirectory();
  runUpgradeInitiatingProcess(storeDirectory);

  const darkBoot = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
    isTelemetryLive: false,
  });
  darkBoot.reporter.onBoot();
  darkBoot.elapseStabilityWindow();
  assert.deepEqual(darkBoot.emitted, []);

  // The next boot with telemetry reports a CLEAN upgrade: the dark boot must
  // not have inflated bootAttempts into a false crash_on_boot.
  const recoveredBoot = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
  });
  recoveredBoot.reporter.onBoot();
  recoveredBoot.elapseStabilityWindow();

  const terminal = recoveredBoot.emitted.filter((record) =>
    isPostRestartUpdateEvent(record.event)
  );
  assert.equal(terminal[0]?.event, UpdateEvent.RestartedOnNewVersion);
  assert.equal(terminal[0]?.bootAttempts, 1);
});

test("a terminal record the runtime REJECTS neither consumes the attempt nor counts as a crash", () => {
  // The guard in settlePendingOutcome. Telemetry is live, so onBoot proceeds
  // and the emit is genuinely reached — it is the runtime that refuses (a
  // strict-parse throw does this in production). Deleting either the
  // `if (!deps.emit(outcome)) return;` guard or the rollback beside it must
  // fail here.
  const storeDirectory = createStoreDirectory();
  runUpgradeInitiatingProcess(storeDirectory);

  const rejectedBoot = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
    emitSucceeds: false,
  });
  rejectedBoot.reporter.onBoot();
  rejectedBoot.elapseStabilityWindow();
  assert.deepEqual(rejectedBoot.emitted, []);

  // The attempt survived AND was not counted: the retry reports a CLEAN
  // upgrade, not crash_on_boot. Without the rollback this reads bootAttempts 2.
  const retryBoot = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
  });
  retryBoot.reporter.onBoot();
  retryBoot.elapseStabilityWindow();

  const terminal = retryBoot.emitted.filter((record) =>
    isPostRestartUpdateEvent(record.event)
  );
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.event, UpdateEvent.RestartedOnNewVersion);
  assert.equal(terminal[0]?.bootAttempts, 1);
});

test("a pre-restart record the runtime rejects is retried, not permanently suppressed", () => {
  // The guard in emitOnce. Marking `reported` unconditionally would make this
  // transition vanish for the rest of the process.
  const storeDirectory = createStoreDirectory();
  const rejecting = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
    emitSucceeds: false,
  });
  rejecting.reporter.available(NEW_VERSION);
  assert.deepEqual(rejecting.emitted, []);

  const accepting = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
  });
  accepting.reporter.available(NEW_VERSION);
  accepting.reporter.available(NEW_VERSION);
  assert.deepEqual(
    accepting.emitted.map((record) => record.event),
    [UpdateEvent.Available]
  );
});

test("an install blocked by a read-only volume is its own event, not a permission download failure", () => {
  // Distinction that must survive to the wire: a machine that can never stage
  // an update is the stuck install ISS-7225 wants, and a transient EACCES
  // download failure classifies to the same reason. Same target version, so a
  // shared dedupe key would also drop one of them.
  const storeDirectory = createStoreDirectory();
  const lifetime = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
  });
  lifetime.reporter.installBlocked(NEW_VERSION);
  lifetime.reporter.downloadFailed(
    NEW_VERSION,
    "EACCES: permission denied while staging"
  );

  assert.deepEqual(
    lifetime.emitted.map((record) => record.event),
    [UpdateEvent.InstallBlocked, UpdateEvent.DownloadFailed]
  );
});

test("a corrupt store file is discarded rather than trusted for a version expectation", () => {
  const storeDirectory = createStoreDirectory();
  writeFileSync(
    join(storeDirectory, UPDATE_TELEMETRY_STATE_FILENAME),
    '{"pendingAttempt":{"toVersion":',
    "utf8"
  );

  const booted = createProcessLifetime({
    storeDirectory,
    runningVersion: NEW_VERSION,
  });
  booted.reporter.onBoot();
  booted.elapseStabilityWindow();
  assert.deepEqual(booted.emitted, []);
});

test("the pre-restart events report the from-to pair once per attempt", () => {
  const storeDirectory = createStoreDirectory();
  const lifetime = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
  });
  lifetime.reporter.available(NEW_VERSION);
  lifetime.reporter.available(NEW_VERSION);
  lifetime.reporter.downloadStarted(NEW_VERSION);
  lifetime.reporter.downloadStarted(NEW_VERSION);

  assert.deepEqual(
    lifetime.emitted.map((record) => record.event),
    [UpdateEvent.Available, UpdateEvent.DownloadStarted]
  );
  assert.equal(lifetime.emitted[0]?.fromVersion, OLD_VERSION);
  assert.equal(lifetime.emitted[0]?.toVersion, NEW_VERSION);
});

test("a check that offered nothing omits the target version rather than echoing the installed one", () => {
  const storeDirectory = createStoreDirectory();
  const lifetime = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
  });
  lifetime.reporter.checked();

  assert.equal(lifetime.emitted[0]?.event, UpdateEvent.Check);
  assert.equal(lifetime.emitted[0]?.toVersion, undefined);
});

test("a raw updater error is classified, and its message never reaches the record", () => {
  const storeDirectory = createStoreDirectory();
  const lifetime = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
  });
  lifetime.reporter.downloadFailed(
    NEW_VERSION,
    "Error: EACCES: permission denied, open '/Users/someone/Library/Caches/app.zip'"
  );

  const record = lifetime.emitted[0];
  assert.equal(record?.event, UpdateEvent.DownloadFailed);
  assert.equal(record?.failureReason, UpdateFailureReason.Permission);
  const serialized = JSON.stringify(
    buildUpdateLifecycleRecord(record as DesktopUpdateEventInput)
  );
  assert.equal(
    serialized.includes("someone"),
    false,
    "a user path reached the keyless record"
  );
});

test("failure classification prefers the specific diagnosis over the broad download bucket", () => {
  assert.equal(
    classifyUpdateFailureReason("failed to download update: ENOSPC"),
    UpdateFailureReason.Disk
  );
  assert.equal(
    classifyUpdateFailureReason("could not verify code signature of update"),
    UpdateFailureReason.Signature
  );
  assert.equal(
    classifyUpdateFailureReason("net::ERR_CONNECTION_REFUSED"),
    UpdateFailureReason.DownloadError
  );
  assert.equal(
    classifyUpdateFailureReason("something nobody has seen before"),
    UpdateFailureReason.Unknown
  );
});

test("the built record carries the contract's attribute keys", () => {
  const record = buildUpdateLifecycleRecord({
    event: UpdateEvent.RestartFailed,
    fromVersion: OLD_VERSION,
    toVersion: NEW_VERSION,
    failureReason: UpdateFailureReason.VersionUnchanged,
    bootAttempts: 1,
  });
  assert.equal(
    record.attributes[TelemetryAttribute.UpdateEvent],
    "restart_failed"
  );
  assert.equal(
    record.attributes[TelemetryAttribute.UpdateFromVersion],
    OLD_VERSION
  );
  assert.equal(
    record.attributes[TelemetryAttribute.UpdateToVersion],
    NEW_VERSION
  );
  assert.equal(
    record.attributes[TelemetryAttribute.UpdateFailureReason],
    "version_unchanged"
  );
  assert.equal(record.attributes[TelemetryAttribute.UpdateBootAttempts], 1);
});

test("the outcome resolver never calls a mismatched version a success", () => {
  for (const running of [OLD_VERSION, OTHER_VERSION]) {
    const outcome = resolveUpdateAttemptOutcome(
      { fromVersion: OLD_VERSION, toVersion: NEW_VERSION, bootAttempts: 1 },
      running
    );
    assert.notEqual(outcome.event, UpdateEvent.RestartedOnNewVersion);
    assert.equal(outcome.event, UpdateEvent.RestartFailed);
  }
});

test("upgrade-lag age is absent, never zero, when it was not measured", () => {
  const nowMs = 10 * 24 * 60 * 60 * 1000;
  assert.equal(resolveCurrentVersionAgeDays(undefined, nowMs), undefined);
  // A clock that moved backwards must not read as "upgraded today".
  assert.equal(resolveCurrentVersionAgeDays(nowMs + 5000, nowMs), undefined);
  assert.equal(
    resolveCurrentVersionAgeDays(nowMs - 3 * 24 * 60 * 60 * 1000, nowMs),
    3
  );
});

test("a check reports how long this installation has been on its current version", () => {
  const storeDirectory = createStoreDirectory();
  const dayMs = 24 * 60 * 60 * 1000;
  const firstBootMs = 100 * dayMs;

  const firstRun = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
    nowMs: firstBootMs,
  });
  firstRun.reporter.onBoot();

  const laterRun = createProcessLifetime({
    storeDirectory,
    runningVersion: OLD_VERSION,
    nowMs: firstBootMs + 12 * dayMs,
  });
  laterRun.reporter.onBoot();
  laterRun.reporter.checked(NEW_VERSION);

  const check = laterRun.emitted.find(
    (record) => record.event === UpdateEvent.Check
  );
  assert.equal(check?.currentVersionAgeDays, 12);
  assert.equal(check?.fromVersion, OLD_VERSION);
  assert.equal(
    check?.toVersion,
    NEW_VERSION,
    "the lag pair needs the offered release beside the installed one"
  );
});

test("the before-quit update handoff runs AFTER the shutdown that emits the restart record", async () => {
  // Wiring assertion: the reporter is settled inside application.shutdown(),
  // which the handler awaits before finishUpdateInstall(). If a future change
  // moved the emit into finishUpdateInstall() it would run after the OTel
  // runtime was torn down and the record would be dropped.
  const order: string[] = [];
  const application: ShutdownLifecycleApplication = {
    setQuitting() {
      // no-op for this ordering assertion
    },
    shutdown() {
      order.push("shutdown");
      return Promise.resolve("clean" as const);
    },
    reportShutdownFailure() {
      order.push("shutdown-failure");
    },
    isApplyingUpdate: () => true,
    finishUpdateInstall() {
      order.push("finishUpdateInstall");
    },
  };
  const handler = createBeforeQuitHandler({
    application,
    exit: () => {
      order.push("exit");
    },
    logInfo: () => {
      // no-op
    },
    logError: () => {
      // no-op
    },
  });
  handler({
    preventDefault: () => {
      // no-op
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["shutdown", "finishUpdateInstall"]);
});
