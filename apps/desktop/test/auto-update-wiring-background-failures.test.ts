/**
 * @file auto-update-wiring-background-failures.test.ts
 * @description ISS-11645 pins for `src/main/update/auto-update-wiring.ts`: a
 * check failure no caller is waiting on stays off the banner until background
 * checks have failed for 24 h, which network errors are held back that way
 * (ISS-12174), and the failures that still surface at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isUpdateBannerVisible,
  updateBannerMessage,
} from "../src/renderer/components/update-banner-state.js";
import { deferred } from "./deferred.js";
import {
  AUTO_UPDATE_TAG,
  CHECK_FAILURE_DETAIL,
  COMPUTE_TARGET_ID,
  createWiringLane,
  DOWNLOAD_FAILURE_DETAIL,
  emit,
  type HarnessOptions,
  NETWORK_MESSAGE,
  OFFERED_VERSION,
  PAST_ONE_POLL_MS,
  resetWiringHarness,
  restoreWiringHarness,
  TIMED_OUT_MESSAGE,
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

const { checkForStampedUpdates, installDesktopUpdateLane } = await import(
  "../src/main/update/auto-update-wiring.js"
);
const { gatewayLog } = await import("../src/main/logging/gateway-logger.js");
const { Observability } = await import(
  "../src/main/telemetry/observability.js"
);

const NETWORK_IO_SUSPENDED_MESSAGE = "net::ERR_NETWORK_IO_SUSPENDED";
/** ISS-12174: a network change, and Chromium's spellings of held-back Node codes. */
const NETWORK_CHANGED_AND_CONNECTION_MESSAGES = [
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_CONNECTION_TIMED_OUT",
];
const FEED_NOT_FOUND_MESSAGE = "HttpError: 404 Not Found";
/** The existing banner string for a timed-out check (ISS-11645 adds no copy). */
const TIMED_OUT_BANNER_MESSAGE = "Update error: net::ERR_TIMED_OUT";
/**
 * Perrin's 24 h example threshold (ISS-11645). A literal, not the production
 * constant, so a change to that constant fails this suite instead of moving with it.
 */
const PERSISTENT_FAILURE_MS = 24 * 60 * 60 * 1000;
const STREAK_START_MS = Date.parse("2026-09-30T00:00:00.000Z");

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

describe("background check failures (ISS-11645)", () => {
  it("keep off the banner until background checks have failed for 24 h, then surface once", async () => {
    const { deps, telemetry, readState, readBanner } =
      await startWiringWithBootSettled();
    const firstFailure = STREAK_START_MS + PAST_ONE_POLL_MS;

    failCheckWithNoCallerAt(firstFailure);
    failCheckWithNoCallerAt(firstFailure + PERSISTENT_FAILURE_MS - 1);

    expect(telemetry.checkFailed.mock.calls).toEqual([
      [TIMED_OUT_MESSAGE],
      [TIMED_OUT_MESSAGE],
    ]);
    expect(deps.setPackagedUpdateState).not.toHaveBeenCalled();
    expect(deps.notifyPackagedUpdateStatus).not.toHaveBeenCalled();
    expect(Observability.electronUpdateFailed).not.toHaveBeenCalled();
    expect(isUpdateBannerVisible(readBanner())).toBe(false);

    failCheckWithNoCallerAt(firstFailure + PERSISTENT_FAILURE_MS + 1);

    expect(readState()).toMatchObject({
      status: "error",
      error: TIMED_OUT_MESSAGE,
    });
    expect(updateBannerMessage(readBanner())).toBe(TIMED_OUT_BANNER_MESSAGE);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "updater-error" })
    );

    failCheckWithNoCallerAt(
      firstFailure + PERSISTENT_FAILURE_MS + PAST_ONE_POLL_MS
    );

    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
    expect(telemetry.checkFailed).toHaveBeenCalledTimes(4);
  });

  it("restart the 24 h, and the once-only report, after a check finds no update", async () => {
    const { readBanner } = await startWiringWithBootSettled();
    failCheckWithNoCallerAt(STREAK_START_MS);
    failCheckWithNoCallerAt(STREAK_START_MS + PERSISTENT_FAILURE_MS);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);

    const success = STREAK_START_MS + PERSISTENT_FAILURE_MS + PAST_ONE_POLL_MS;
    vi.setSystemTime(success);
    emit("update-not-available", { version: STUB_APP_VERSION });
    // The next run starts at its own first failure, not at the success.
    const nextFailure = success + PERSISTENT_FAILURE_MS + 1;
    failCheckWithNoCallerAt(nextFailure);

    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
    expect(isUpdateBannerVisible(readBanner())).toBe(false);

    failCheckWithNoCallerAt(nextFailure + PERSISTENT_FAILURE_MS);

    expect(updateBannerMessage(readBanner())).toBe(TIMED_OUT_BANNER_MESSAGE);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(2);
  });

  it("restart the 24 h after a check offers an update", async () => {
    await startWiringWithBootSettled();

    failCheckWithNoCallerAt(STREAK_START_MS);
    emit("update-available", { version: OFFERED_VERSION });
    // The offer's download fails, so nothing is in flight for the next check.
    emit("error", new Error(TIMED_OUT_MESSAGE), DOWNLOAD_FAILURE_DETAIL);
    failCheckWithNoCallerAt(STREAK_START_MS + PERSISTENT_FAILURE_MS + 1);

    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledWith(
      expect.objectContaining({ version: OFFERED_VERSION })
    );
  });

  it("leave a download failure to surface at once", async () => {
    const { telemetry, readBanner } = await startWiringWithBootSettled({
      initialState: {
        status: "downloading",
        available: true,
        downloaded: false,
        version: OFFERED_VERSION,
      },
    });

    emit("error", new Error(TIMED_OUT_MESSAGE), DOWNLOAD_FAILURE_DETAIL);

    expect(telemetry.downloadFailed).toHaveBeenCalledWith(
      OFFERED_VERSION,
      TIMED_OUT_MESSAGE
    );
    expect(telemetry.checkFailed).not.toHaveBeenCalled();
    expect(updateBannerMessage(readBanner())).toBe(TIMED_OUT_BANNER_MESSAGE);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it("keep counting when handling a check's result throws", async () => {
    const { deps, readBanner } = await startWiringWithBootSettled();

    failCheckWithNoCallerAt(STREAK_START_MS);
    deps.notifyPackagedUpdateStatus.mockImplementationOnce(() => {
      throw new Error("renderer gone");
    });
    expect(() =>
      emit("update-not-available", { version: STUB_APP_VERSION })
    ).toThrow("renderer gone");
    failCheckWithNoCallerAt(STREAK_START_MS + PERSISTENT_FAILURE_MS + 1);

    expect(updateBannerMessage(readBanner())).toBe(TIMED_OUT_BANNER_MESSAGE);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it("include a failed recurring poll", async () => {
    const { deps, telemetry, readBanner } = await startWiringWithBootSettled();
    updater.stub.checkForUpdates.mockImplementationOnce(failCheckLikeUpdater);

    await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS);

    expect(updater.stub.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(telemetry.checkFailed.mock.calls).toEqual([[TIMED_OUT_MESSAGE]]);
    expect(deps.notifyPackagedUpdateStatus).not.toHaveBeenCalled();
    expect(Observability.electronUpdateFailed).not.toHaveBeenCalled();
    expect(isUpdateBannerVisible(readBanner())).toBe(false);
  });

  it("exclude a check a caller is waiting on, until it settles", async () => {
    const { readBanner } = await startWiringWithBootSettled();
    updater.stub.checkForUpdates.mockImplementationOnce(failCheckLikeUpdater);

    await expect(
      checkForStampedUpdates(() => COMPUTE_TARGET_ID)
    ).rejects.toThrow(TIMED_OUT_MESSAGE);

    expect(updateBannerMessage(readBanner())).toBe(TIMED_OUT_BANNER_MESSAGE);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);

    failCheckWithNoCallerAt(STREAK_START_MS + PAST_ONE_POLL_MS);

    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it("count a failure that surfaced at once as the run's one report", async () => {
    await startWiringWithBootSettled();
    failCheckWithNoCallerAt(STREAK_START_MS);

    vi.setSystemTime(STREAK_START_MS + PAST_ONE_POLL_MS);
    updater.stub.checkForUpdates.mockImplementationOnce(failCheckLikeUpdater);
    await expect(
      checkForStampedUpdates(() => COMPUTE_TARGET_ID)
    ).rejects.toThrow(TIMED_OUT_MESSAGE);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);

    failCheckWithNoCallerAt(STREAK_START_MS + PERSISTENT_FAILURE_MS + 1);

    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it("count the persistent background report as the run's one when a waited-on check then fails", async () => {
    const { telemetry, readBanner } = await startWiringWithBootSettled();
    failCheckWithNoCallerAt(STREAK_START_MS);
    failCheckWithNoCallerAt(STREAK_START_MS + PERSISTENT_FAILURE_MS + 1);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);

    vi.setSystemTime(
      STREAK_START_MS + PERSISTENT_FAILURE_MS + PAST_ONE_POLL_MS
    );
    updater.stub.checkForUpdates.mockImplementationOnce(failCheckLikeUpdater);
    await expect(
      checkForStampedUpdates(() => COMPUTE_TARGET_ID)
    ).rejects.toThrow(TIMED_OUT_MESSAGE);

    expect(updateBannerMessage(readBanner())).toBe(TIMED_OUT_BANNER_MESSAGE);
    expect(telemetry.checkFailed).toHaveBeenCalledTimes(3);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it("log a held-back failure at debug and the one that surfaces at error", async () => {
    await startWiringWithBootSettled();
    const debug = vi.spyOn(gatewayLog, "debug");
    const error = vi.spyOn(gatewayLog, "error");
    const logged = [AUTO_UPDATE_TAG, `Auto-update error: ${TIMED_OUT_MESSAGE}`];

    failCheckWithNoCallerAt(STREAK_START_MS);

    expect(debug).toHaveBeenCalledWith(...logged);
    expect(error).not.toHaveBeenCalled();

    failCheckWithNoCallerAt(STREAK_START_MS + PERSISTENT_FAILURE_MS + 1);

    expect(error.mock.calls).toEqual([logged]);
  });

  it.each([
    NETWORK_MESSAGE,
    TIMED_OUT_MESSAGE,
    NETWORK_IO_SUSPENDED_MESSAGE,
    ...NETWORK_CHANGED_AND_CONNECTION_MESSAGES,
  ])("hold back the network error %s until 24 h", async (message) => {
    const { deps, telemetry, readState, readBanner } =
      await startWiringWithBootSettled();

    failCheckWithNoCallerAt(STREAK_START_MS, message);

    expect(telemetry.checkFailed.mock.calls).toEqual([[message]]);
    expect(deps.setPackagedUpdateState).not.toHaveBeenCalled();
    expect(Observability.electronUpdateFailed).not.toHaveBeenCalled();
    expect(isUpdateBannerVisible(readBanner())).toBe(false);

    const persistent = STREAK_START_MS + PERSISTENT_FAILURE_MS + 1;
    failCheckWithNoCallerAt(persistent, message);

    expect(readState()).toMatchObject({ status: "error", error: message });
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it.each(NETWORK_CHANGED_AND_CONNECTION_MESSAGES)(
    "surface %s at once to the boot check, then to a manual or gateway check",
    async (message) => {
      const { readState, downloadGuarded } = startWiring();
      emit("error", new Error(message), CHECK_FAILURE_DETAIL);
      expect(readState()).toMatchObject({ status: "error", error: message });

      await downloadGuarded;
      emit("update-not-available", { version: STUB_APP_VERSION });
      updater.stub.checkForUpdates.mockImplementationOnce(() =>
        failCheckLikeUpdater(message)
      );
      await expect(
        checkForStampedUpdates(() => COMPUTE_TARGET_ID)
      ).rejects.toThrow(message);

      expect(readState()).toMatchObject({ status: "error", error: message });
      expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(2);
    }
  );

  it("surface a failure that is not a network error at once", async () => {
    const { telemetry, readState, readBanner } =
      await startWiringWithBootSettled();

    failCheckWithNoCallerAt(STREAK_START_MS, FEED_NOT_FOUND_MESSAGE);

    expect(readState()).toMatchObject({
      status: "error",
      error: FEED_NOT_FOUND_MESSAGE,
    });
    expect(isUpdateBannerVisible(readBanner())).toBe(true);
    expect(telemetry.checkFailed).toHaveBeenCalledWith(FEED_NOT_FOUND_MESSAGE);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });

  it("exclude a poll's check that a manual check joined", async () => {
    const { readBanner } = await startWiringWithBootSettled();
    // electron-updater hands a second caller the check already in flight.
    const shared = deferred<null>();
    updater.stub.checkForUpdates.mockImplementation(() => shared.promise);
    await vi.advanceTimersByTimeAsync(PAST_ONE_POLL_MS);
    const manualCheck = checkForStampedUpdates(() => COMPUTE_TARGET_ID);

    const failure = new Error(TIMED_OUT_MESSAGE);
    emit("error", failure, CHECK_FAILURE_DETAIL);
    shared.reject(failure);

    await expect(manualCheck).rejects.toBe(failure);
    expect(updater.stub.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(updateBannerMessage(readBanner())).toBe(TIMED_OUT_BANNER_MESSAGE);
    expect(Observability.electronUpdateFailed).toHaveBeenCalledTimes(1);
  });
});

/** Start the lane on a fake clock and wait out its boot check, so no caller is waiting. */
async function startWiringWithBootSettled(options: HarnessOptions = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(STREAK_START_MS);
  const lane = startWiring(options);
  await lane.downloadGuarded;
  return lane;
}

/** A check failure no caller is waiting on, as the updater reports it, at `time`. */
function failCheckWithNoCallerAt(
  time: number,
  message: string = TIMED_OUT_MESSAGE
): void {
  vi.setSystemTime(time);
  emit("error", new Error(message), CHECK_FAILURE_DETAIL);
}

/** electron-updater 6.8.7's failed check: `error` with the check detail, then reject. */
function failCheckLikeUpdater(message = TIMED_OUT_MESSAGE): Promise<unknown> {
  const failure = new Error(message);
  emit("error", failure, CHECK_FAILURE_DETAIL);
  return Promise.reject(failure);
}
