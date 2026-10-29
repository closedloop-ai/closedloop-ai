/**
 * @file auto-update-wiring-coverage.test.ts
 * @description ISS-10514 behavior pins for `src/main/update/auto-update-wiring.ts`
 * past the request-header contract (`auto-update-request-headers.test.ts` owns
 * that half): the updater state machine, the error channel, the translocation
 * and fake-feed guards, the boot/poll failure paths, and the dev-mode nudge.
 * Background check failures (ISS-11645) are
 * `auto-update-wiring-background-failures.test.ts`'s.
 *
 * `electron-updater` is module-mocked with a recording emitter, because its
 * `MacUpdater` touches `require("electron").autoUpdater` at construction
 * (ISS-4514). The emitter keeps registration order, which is what the
 * narrowing-before-early-return pin reads. Pins CURRENT behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogMessageFactory } from "../src/main/logging/gateway-logger.js";
import type { PackagedUpdateState } from "../src/main/update/packaged-update-state.js";
import { deferred } from "./deferred.js";
import {
  AUTO_UPDATE_TAG,
  CHECK_FAILURE_DETAIL,
  COMPUTE_TARGET_ID,
  createWiringLane,
  DOWNLOAD_FAILURE_DETAIL,
  emit,
  type HarnessOptions,
  handlersFor,
  NETWORK_MESSAGE,
  OFFERED_VERSION,
  PAST_ONE_POLL_MS,
  resetWiringHarness,
  restoreWiringHarness,
  TIMED_OUT_MESSAGE,
  timers,
  updater,
} from "./helpers/auto-update-wiring-harness.js";
import { STUB_APP_VERSION } from "./helpers/electron-module-stub.js";

vi.mock("electron-updater", async () => {
  const { updater: double } = await import(
    "./helpers/auto-update-wiring-harness.js"
  );
  return { default: { autoUpdater: double.stub }, autoUpdater: double.stub };
});

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

const { installDesktopUpdateLane } = await import(
  "../src/main/update/auto-update-wiring.js"
);
const { gatewayLog } = await import("../src/main/logging/gateway-logger.js");
const { Observability } = await import(
  "../src/main/telemetry/observability.js"
);

/** Wire spellings, written out rather than read off the contract module. */
const COMPUTE_TARGET_ID_HEADER = "x-desktop-compute-target-id";
const CLIENT_VERSION_HEADER = "x-desktop-client-version";
const READ_ONLY_VOLUME_MESSAGE =
  "Cannot update while running on a read-only volume";
const GENERIC_UPDATER_MESSAGE = "feed returned 500";

/** Runs the lazy message factory a `gatewayLog.debug` call was handed. */
function debugMessages(spy: {
  mock: { calls: [string, LogMessageFactory][] };
}): string[] {
  return spy.mock.calls.map(([, message]) =>
    typeof message === "function" ? String(message()) : String(message)
  );
}

function startWiring(options: HarnessOptions = {}) {
  const lane = createWiringLane(options);
  installDesktopUpdateLane(lane.deps)();
  return lane;
}

beforeEach(() => {
  resetWiringHarness();
  vi.spyOn(Observability, "electronUpdateFailed").mockImplementation(() => {
    // Recorded, not emitted: the real call reaches the telemetry transport.
  });
});

afterEach(() => {
  restoreWiringHarness();
  vi.useRealTimers();
});

describe("translocated install (FEA-2349)", () => {
  it("disables download and install and warns at wiring time", () => {
    const warn = vi.spyOn(gatewayLog, "warn");
    startWiring({ translocated: true });

    expect(updater.stub.autoDownload).toBe(false);
    expect(updater.stub.autoInstallOnAppQuit).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      AUTO_UPDATE_TAG,
      "App is translocated (read-only volume); update install disabled until the app is moved to /Applications"
    );
  });

  it("registers the header narrowing before the state machine, so its early return cannot skip it", () => {
    const { deps, telemetry } = startWiring({ translocated: true });

    expect(updater.registrations.map(([event]) => event)).toEqual([
      "error",
      "update-available",
      "update-available",
      "download-progress",
      "update-downloaded",
      "update-not-available",
      // ISS-11645's streak reset, after every handler that can throw.
      "update-available",
      "update-not-available",
    ]);
    expect(updater.stub.requestHeaders).toEqual({
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });

    const [narrowing, stateMachine] = handlersFor("update-available");
    stateMachine({ version: OFFERED_VERSION });

    // The state machine took its early return and left the id stamped.
    expect(telemetry.checked).toHaveBeenCalledWith(OFFERED_VERSION);
    expect(telemetry.available).toHaveBeenCalledWith(OFFERED_VERSION);
    expect(telemetry.installBlocked).toHaveBeenCalledWith(OFFERED_VERSION);
    expect(deps.handleUpdateInstallBlocked).toHaveBeenCalledWith(
      OFFERED_VERSION
    );
    expect(deps.setPackagedUpdateState).not.toHaveBeenCalled();
    expect(deps.sendUpdateAvailableToRenderer).not.toHaveBeenCalled();
    expect(updater.stub.requestHeaders).toEqual({
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });

    narrowing({ version: OFFERED_VERSION });
    expect(deps.handleUpdateInstallBlocked).toHaveBeenCalledTimes(1);
    expect(updater.stub.requestHeaders).toEqual({
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
  });

  it("does not take the early return when the fake feed is also active", () => {
    const { deps, telemetry, readState } = startWiring({
      isPackaged: false,
      fakeFeed: true,
      translocated: true,
    });

    emit("update-available", { version: OFFERED_VERSION });

    expect(telemetry.installBlocked).not.toHaveBeenCalled();
    expect(deps.handleUpdateInstallBlocked).not.toHaveBeenCalled();
    expect(deps.sendUpdateAvailableToRenderer).toHaveBeenCalledWith({
      updateAvailable: true,
      version: OFFERED_VERSION,
      readyToInstall: false,
    });
    // The fake feed forces autoDownload off, so no download is reported.
    expect(telemetry.downloadStarted).not.toHaveBeenCalled();
    expect(readState()).toMatchObject({
      status: "downloaded",
      downloaded: true,
      percent: 100,
      version: OFFERED_VERSION,
    });
  });
});

describe("update-available state machine", () => {
  it("reports a download start only when autoDownload is on", () => {
    const { deps, telemetry, readState } = startWiring();

    emit("update-available", { version: OFFERED_VERSION });

    expect(updater.stub.autoDownload).toBe(true);
    expect(telemetry.downloadStarted).toHaveBeenCalledWith(OFFERED_VERSION);
    expect(readState()).toMatchObject({
      status: "available",
      available: true,
      downloaded: false,
      version: OFFERED_VERSION,
    });
    expect(deps.notifyPackagedUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it("advances straight to downloaded on the fake feed", () => {
    const info = vi.spyOn(gatewayLog, "info");
    const { deps, readState } = startWiring({
      isPackaged: false,
      fakeFeed: true,
    });

    emit("update-available", { version: OFFERED_VERSION });

    expect(readState()).toMatchObject({
      status: "downloaded",
      available: true,
      downloaded: true,
      percent: 100,
      version: OFFERED_VERSION,
    });
    expect(deps.notifyPackagedUpdateStatus).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(
      AUTO_UPDATE_TAG,
      `fake-feed: marked downloaded version=${OFFERED_VERSION}`
    );
  });
});

describe("download-progress and update-not-available", () => {
  it("clamps a numeric percent into 0..100 and logs it with the version", () => {
    const debug = vi.spyOn(gatewayLog, "debug");
    const { readState } = startWiring({
      initialState: {
        status: "available",
        available: true,
        downloaded: false,
        version: OFFERED_VERSION,
      },
    });

    emit("download-progress", { percent: 150 });
    expect(readState()).toMatchObject({
      status: "downloading",
      percent: 100,
    });
    emit("download-progress", { percent: -5 });
    expect(readState().percent).toBe(0);
    emit("download-progress", { percent: 42.25 });
    expect(readState().percent).toBe(42.25);

    expect(debugMessages(debug)).toEqual([
      `Update download progress version=${OFFERED_VERSION} percent=100.0`,
      `Update download progress version=${OFFERED_VERSION} percent=0.0`,
      `Update download progress version=${OFFERED_VERSION} percent=42.3`,
    ]);
  });

  it("records no percent and logs unknown for a non-numeric progress with no version", () => {
    const debug = vi.spyOn(gatewayLog, "debug");
    const { readState } = startWiring();

    emit("download-progress", {});

    expect(readState()).toMatchObject({
      status: "downloading",
      available: true,
      downloaded: false,
    });
    expect(readState().percent).toBeUndefined();
    expect(debugMessages(debug)).toEqual([
      "Update download progress version=unknown percent=unknown",
    ]);
  });

  it("logs the installed version, or unknown, when no update is offered", () => {
    const debug = vi.spyOn(gatewayLog, "debug");
    const { telemetry, readState } = startWiring();

    emit("update-not-available", { version: STUB_APP_VERSION });
    expect(readState()).toMatchObject({
      status: "not-available",
      available: false,
      version: STUB_APP_VERSION,
    });
    emit("update-not-available", {});

    expect(telemetry.checked).toHaveBeenCalledWith();
    expect(debugMessages(debug)).toEqual([
      `No packaged update available version=${STUB_APP_VERSION}`,
      "No packaged update available version=unknown",
    ]);
  });
});

describe("updater error channel", () => {
  it("logs a network error at debug and a check-phase failure as checkFailed", () => {
    const debug = vi.spyOn(gatewayLog, "debug");
    const error = vi.spyOn(gatewayLog, "error");
    const { deps, telemetry, readState } = startWiring();

    emit("error", new Error(NETWORK_MESSAGE));

    expect(debug).toHaveBeenCalledWith(
      AUTO_UPDATE_TAG,
      `Auto-update error: ${NETWORK_MESSAGE}`
    );
    expect(error).not.toHaveBeenCalled();
    expect(telemetry.checkFailed).toHaveBeenCalledWith(NETWORK_MESSAGE);
    expect(telemetry.downloadFailed).not.toHaveBeenCalled();
    expect(readState()).toMatchObject({
      status: "error",
      available: false,
      downloaded: false,
      error: NETWORK_MESSAGE,
    });
    expect(deps.notifyPackagedUpdateStatus).toHaveBeenCalledTimes(1);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledWith({
      trigger: "updater-error",
      status: "error",
      version: undefined,
      error: NETWORK_MESSAGE,
      downloaded: false,
      readyToInstall: false,
    });
  });

  it("names the offered release when the error lands mid-download", () => {
    const error = vi.spyOn(gatewayLog, "error");
    const { telemetry, readState } = startWiring({
      initialState: {
        status: "downloading",
        available: true,
        downloaded: false,
        version: OFFERED_VERSION,
      },
    });

    emit("error", new Error(GENERIC_UPDATER_MESSAGE));

    expect(error).toHaveBeenCalledWith(
      AUTO_UPDATE_TAG,
      `Auto-update error: ${GENERIC_UPDATER_MESSAGE}`
    );
    expect(telemetry.downloadFailed).toHaveBeenCalledWith(
      OFFERED_VERSION,
      GENERIC_UPDATER_MESSAGE
    );
    expect(telemetry.checkFailed).not.toHaveBeenCalled();
    // The error patch does not clear the version, so the failure event keeps it.
    expect(Observability.electronUpdateFailed).toHaveBeenCalledWith({
      trigger: "updater-error",
      status: "error",
      version: OFFERED_VERSION,
      error: GENERIC_UPDATER_MESSAGE,
      downloaded: false,
      readyToInstall: false,
    });
    expect(readState().error).toBe(GENERIC_UPDATER_MESSAGE);
  });

  it.each(["available", "downloading", "downloaded"] as const)(
    "a failed check leaves an in-flight %s update where it was (ISS-11447)",
    (status) => {
      const inFlight: PackagedUpdateState = {
        status,
        available: true,
        downloaded: status === "downloaded",
        version: OFFERED_VERSION,
      };
      const { deps, telemetry, readState } = startWiring({
        initialState: inFlight,
      });

      emit("error", new Error(TIMED_OUT_MESSAGE), CHECK_FAILURE_DETAIL);

      expect(readState()).toEqual(inFlight);
      expect(deps.notifyPackagedUpdateStatus).not.toHaveBeenCalled();
      expect(telemetry.checkFailed).toHaveBeenCalledWith(TIMED_OUT_MESSAGE);
      expect(telemetry.downloadFailed).not.toHaveBeenCalled();
      expect(Observability.electronUpdateFailed).not.toHaveBeenCalled();
    }
  );

  it("still fails a downloaded update on an error that is not a check's", () => {
    const { telemetry, readState } = startWiring({
      initialState: {
        status: "downloaded",
        available: true,
        downloaded: true,
        version: OFFERED_VERSION,
      },
    });

    emit("error", new Error(TIMED_OUT_MESSAGE), DOWNLOAD_FAILURE_DETAIL);

    expect(readState()).toMatchObject({
      status: "error",
      downloaded: false,
      error: TIMED_OUT_MESSAGE,
    });
    expect(telemetry.downloadFailed).toHaveBeenCalledWith(
      OFFERED_VERSION,
      TIMED_OUT_MESSAGE
    );
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it("reports a check that fails after a failed download as check_failed", () => {
    // The ISS-7247 "second error" state: a download of 99.0.0 already failed.
    // Only the updater's check detail tells this poll apart from that download.
    const { telemetry, readState } = startWiring({
      initialState: {
        status: "error",
        available: false,
        downloaded: false,
        version: OFFERED_VERSION,
        error: TIMED_OUT_MESSAGE,
      },
    });

    emit("error", new Error(TIMED_OUT_MESSAGE), CHECK_FAILURE_DETAIL);

    expect(telemetry.checkFailed).toHaveBeenCalledWith(TIMED_OUT_MESSAGE);
    expect(telemetry.downloadFailed).not.toHaveBeenCalled();
    expect(readState()).toMatchObject({ status: "error", downloaded: false });
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it("still surfaces a failed check the boot check is waiting on when no update is in flight", () => {
    const { telemetry, readState } = startWiring({
      initialState: {
        status: "not-available",
        available: false,
        downloaded: false,
        version: STUB_APP_VERSION,
      },
    });

    emit("error", new Error(TIMED_OUT_MESSAGE), CHECK_FAILURE_DETAIL);

    expect(readState()).toMatchObject({
      status: "error",
      error: TIMED_OUT_MESSAGE,
    });
    expect(telemetry.checkFailed).toHaveBeenCalledWith(TIMED_OUT_MESSAGE);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it("turns a read-only-volume error into an install block without an error state", () => {
    const { deps, telemetry } = startWiring({
      initialState: {
        status: "downloaded",
        available: true,
        downloaded: true,
        version: OFFERED_VERSION,
      },
    });
    expect(updater.stub.autoDownload).toBe(true);
    expect(updater.stub.autoInstallOnAppQuit).toBe(true);

    emit("error", new Error(READ_ONLY_VOLUME_MESSAGE));

    expect(updater.stub.autoDownload).toBe(false);
    expect(updater.stub.autoInstallOnAppQuit).toBe(false);
    expect(telemetry.installBlocked).toHaveBeenCalledWith(OFFERED_VERSION);
    expect(deps.handleUpdateInstallBlocked).toHaveBeenCalledWith(
      OFFERED_VERSION
    );
    expect(deps.setPackagedUpdateState).not.toHaveBeenCalled();
    expect(deps.notifyPackagedUpdateStatus).not.toHaveBeenCalled();
    expect(telemetry.downloadFailed).not.toHaveBeenCalled();
    expect(Observability.electronUpdateFailed).not.toHaveBeenCalled();
  });
});

describe("boot check failure", () => {
  it.each([
    { label: "an Error", rejection: new Error("boom"), message: "boom" },
    { label: "a non-Error value", rejection: "offline", message: "offline" },
  ])(
    "records $label as an error state and leaves the report to the error listener",
    async ({ rejection, message }) => {
      const logged = deferred();
      const error = vi.spyOn(gatewayLog, "error").mockImplementation(() => {
        logged.resolve();
      });
      updater.stub.checkForUpdates.mockImplementationOnce(() =>
        Promise.reject(rejection)
      );
      const { deps, telemetry, readState } = startWiring();

      await logged.promise;

      expect(error).toHaveBeenCalledWith(
        AUTO_UPDATE_TAG,
        `Failed to check for updates: ${message}`
      );
      expect(deps.guardUpdateDownload).not.toHaveBeenCalled();
      expect(readState()).toMatchObject({
        status: "error",
        available: false,
        downloaded: false,
        error: message,
      });
      expect(deps.notifyPackagedUpdateStatus).toHaveBeenCalledTimes(1);
      expect(telemetry.checkFailed).not.toHaveBeenCalled();
      expect(Observability.electronUpdateFailed).not.toHaveBeenCalled();
    }
  );

  it("counts a failed check once when the updater emits error before rejecting", async () => {
    const logged = deferred();
    // The listener logs this error too; only the catch's line proves it ran.
    vi.spyOn(gatewayLog, "error").mockImplementation((_tag, message) => {
      if (message === `Failed to check for updates: ${TIMED_OUT_MESSAGE}`) {
        logged.resolve();
      }
    });
    const failure = new Error(TIMED_OUT_MESSAGE);
    // electron-updater 6.8.7 emits `error` with the check detail, then rejects
    // with the same error (AppUpdater.js:271).
    updater.stub.checkForUpdates.mockImplementationOnce(() => {
      emit("error", failure, CHECK_FAILURE_DETAIL);
      return Promise.reject(failure);
    });
    const { telemetry, readState } = startWiring();

    await logged.promise;

    expect(readState()).toMatchObject({
      status: "error",
      error: TIMED_OUT_MESSAGE,
    });
    expect(telemetry.checkFailed.mock.calls).toEqual([[TIMED_OUT_MESSAGE]]);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "updater-error" })
    );
  });
});

describe("boot check failure over an update already in flight (ISS-11447)", () => {
  it("leaves a downloaded update ready and reports nothing a second time", async () => {
    const logged = deferred();
    vi.spyOn(gatewayLog, "error").mockImplementation(() => {
      logged.resolve();
    });
    updater.stub.checkForUpdates.mockImplementationOnce(() =>
      Promise.reject(new Error(TIMED_OUT_MESSAGE))
    );
    const downloaded: PackagedUpdateState = {
      status: "downloaded",
      available: true,
      downloaded: true,
      version: OFFERED_VERSION,
    };
    const { deps, telemetry, readState } = startWiring({
      initialState: downloaded,
    });

    await logged.promise;

    expect(readState()).toEqual(downloaded);
    expect(deps.notifyPackagedUpdateStatus).not.toHaveBeenCalled();
    expect(telemetry.checkFailed).not.toHaveBeenCalled();
    expect(Observability.electronUpdateFailed).not.toHaveBeenCalled();
  });
});

describe("recurring packaged poll", () => {
  it.each([
    {
      label: "an Error",
      rejection: new Error("poll down"),
      message: "poll down",
    },
    { label: "a non-Error value", rejection: 503, message: "503" },
  ])(
    "logs $label from a poll at debug only",
    async ({ rejection, message }) => {
      vi.useFakeTimers();
      const debug = vi.spyOn(gatewayLog, "debug");
      const { deps, telemetry, downloadGuarded } = startWiring();
      await downloadGuarded;
      updater.stub.checkForUpdates.mockImplementationOnce(() =>
        Promise.reject(rejection)
      );

      await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS);

      expect(updater.stub.checkForUpdates).toHaveBeenCalledTimes(2);
      expect(debug).toHaveBeenCalledWith(
        AUTO_UPDATE_TAG,
        `Failed to check for updates: ${message}`
      );
      expect(telemetry.checkFailed).not.toHaveBeenCalled();
      expect(Observability.electronUpdateFailed).not.toHaveBeenCalled();
      expect(deps.guardUpdateDownload).toHaveBeenCalledTimes(1);
    }
  );

  it("hands a successful poll's check result to the download guard", async () => {
    vi.useFakeTimers();
    const pollResult = { isUpdateAvailable: true };
    const { deps, downloadGuarded } = startWiring();
    await downloadGuarded;
    updater.stub.checkForUpdates.mockImplementationOnce(() =>
      Promise.resolve(pollResult)
    );

    await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS);

    expect(deps.guardUpdateDownload.mock.calls).toEqual([[null], [pollResult]]);
  });

  it("clears the prior poll timer before arming a new one", async () => {
    vi.useFakeTimers();
    let priorTicks = 0;
    const prior = setInterval(() => {
      priorTicks += 1;
    }, 1000);
    timers.push(prior);

    const { deps } = startWiring({ existingTimer: prior });
    await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS);

    expect(priorTicks).toBe(0);
    expect(deps.setUpdateCheckTimer).toHaveBeenCalledTimes(1);
    expect(updater.stub.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe("dev-mode update nudge", () => {
  it("nudges the renderer when the boot probe finds an update", async () => {
    const { deps, devUpdateNudged } = startWiring({
      isPackaged: false,
      devUpdateAvailable: () => Promise.resolve({ updateAvailable: true }),
    });

    await devUpdateNudged;
    expect(deps.notifyRendererDevUpdateReady).toHaveBeenCalledTimes(1);
    expect(updater.stub.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.registrations).toEqual([]);
  });

  it("nudges from the poll only when the probe reports an update, and swallows a failed probe", async () => {
    vi.useFakeTimers();
    const results = [
      () => Promise.resolve({ updateAvailable: false }),
      () => Promise.reject(new Error("git fetch failed")),
      () => Promise.resolve({ updateAvailable: false }),
      () => Promise.resolve({ updateAvailable: true }),
    ];
    let call = 0;
    const { deps } = startWiring({
      isPackaged: false,
      devUpdateAvailable: () => {
        const next = results[call] ?? results[0];
        call += 1;
        return next();
      },
    });

    await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS);
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(2);
    expect(deps.notifyRendererDevUpdateReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS);
    expect(deps.notifyRendererDevUpdateReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS);
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(4);
    expect(deps.notifyRendererDevUpdateReady).toHaveBeenCalledTimes(1);
  });

  it("clears the prior dev poll timer before arming a new one", async () => {
    vi.useFakeTimers();
    let priorTicks = 0;
    const prior = setInterval(() => {
      priorTicks += 1;
    }, 1000);
    timers.push(prior);

    const { deps } = startWiring({ isPackaged: false, existingTimer: prior });
    await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS);

    expect(priorTicks).toBe(0);
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(2);
  });
});
