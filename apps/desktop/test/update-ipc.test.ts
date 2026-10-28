/**
 * @file update-ipc.test.ts
 * @description ISS-4514 — the last `src/main/ipc/*-ipc.ts` module no test
 * imported.
 *
 * WHY IT WAS LAST. `ipc/update-ipc.ts` reached for `electron-updater` at module
 * scope, which is CJS inside `node_modules` and therefore past the reach of a
 * module mock; on macOS its `MacUpdater` runs
 * `require("electron").autoUpdater.on("error")` at construction, so a suite that
 * imported this module was green on Linux CI and red on any Mac. The probe is
 * now injected as `checkForUpdates`.
 *
 * WHAT IS PINNED, beyond the trust gate: both branches of the check
 * (packaged feed vs the dev probe), both of its failure shapes (a packaged check
 * records state, leaving the report to the updater's `error` listener; a dev
 * probe returns an error payload), the
 * FEA-2099 fake feed taking the packaged branch, and the apply path's refusal to
 * quit before the download finished.
 */
import assert from "node:assert/strict";
import type { UpdateCheckResult, UpdateInfo } from "electron-updater";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { registerUpdateIpcHandlers } from "../src/main/ipc/update-ipc.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { FAKE_UPDATE_FEED_ENV } from "../src/main/update/fake-update-feed.js";
import {
  createInitialPackagedUpdateState,
  mergePackagedUpdateState,
  PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE,
  type PackagedUpdateState,
  toPackagedUpdateStatusPayload,
} from "../src/main/update/packaged-update-state.js";
import { UpdateIpcChannel } from "../src/shared/update-ipc-channel.js";
import {
  electronAppQuitCallCount,
  resetElectronModuleStub,
  setElectronAppIsPackaged,
} from "./helpers/electron-module-stub.js";
import {
  createIpcRegistrar,
  type IpcRegistrarHarness,
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";
import { createUpdateTelemetryDouble } from "./helpers/update-telemetry-double.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

/** A feed version the running build is not. */
const REMOTE_VERSION = "9.9.9";
const FEED_URL = "http://127.0.0.1:65535/fake-feed";
const CHECK_FAILURE_MESSAGE = "feed unreachable";

/** What the unpackaged (git) probe answers with; shape per `checkForUpdate`. */
const DEV_CHECK_RESULT = {
  updateAvailable: true,
  currentHash: "aaaaaaa",
  remoteHash: "bbbbbbb",
};

type UpdateHarnessOptions = {
  isPackaged?: boolean;
  initialState?: Partial<PackagedUpdateState>;
  checkForUpdates?: () => Promise<UpdateCheckResult | null>;
  checkForUpdate?: () => Promise<typeof DEV_CHECK_RESULT>;
};

describe("update IPC registration", () => {
  test("registers exactly the channels the contract declares", () => {
    const { harness } = createUpdateIpc();

    assert.deepEqual(
      [...harness.channels()].sort(),
      Object.values(UpdateIpcChannel).sort()
    );
  });
});

describe("update IPC trusted-sender gate", () => {
  test("check-for-update refuses an untrusted sender before probing any feed", async () => {
    // Packaged, so the packaged branch is the one the gate is standing in front
    // of; both probes are asserted because the gate protects the whole handler.
    const ipc = createUpdateIpc({ isPackaged: true });

    await assert.rejects(
      () =>
        invoke(ipc.harness, UpdateIpcChannel.CheckForUpdate, UNTRUSTED_EVENT),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(ipc.checkForUpdates.mock.calls.length, 0);
    assert.equal(ipc.checkForUpdate.mock.calls.length, 0);
  });

  test("a refused check rejects rather than being reported as a check failure", async () => {
    // The gate sits OUTSIDE the handler's try/catch. Moving it inside would turn
    // every refusal into a resolved error payload — a renderer would read
    // "update check failed", and the packaged error state would be written on
    // behalf of a sender that was never trusted.
    const ipc = createUpdateIpc({ isPackaged: true });

    await assert.rejects(
      () =>
        invoke(ipc.harness, UpdateIpcChannel.CheckForUpdate, UNTRUSTED_EVENT),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(ipc.setPackagedUpdateState.mock.calls.length, 0);
    assert.equal(ipc.notifyPackagedUpdateStatus.mock.calls.length, 0);
    assert.equal(ipc.updateTelemetry.checkFailed.mock.calls.length, 0);
  });

  test("apply-update refuses an untrusted sender before installing anything", async () => {
    // Downloaded and packaged: every guard downstream of the gate would PASS, so
    // a bypass quits the app rather than merely throwing somewhere else.
    const ipc = createUpdateIpc({
      isPackaged: true,
      initialState: downloadedState(),
    });

    await assert.rejects(
      () => invoke(ipc.harness, UpdateIpcChannel.ApplyUpdate, UNTRUSTED_EVENT),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(ipc.setApplyingDownloadedUpdate.mock.calls.length, 0);
    assert.equal(ipc.updateTelemetry.installStarted.mock.calls.length, 0);
    assert.equal(ipc.applyUpdate.mock.calls.length, 0);
    assert.equal(electronAppQuitCallCount(), 0);
  });
});

describe("check-for-update on an unpackaged build", () => {
  test("answers with the dev probe's result and never touches the packaged feed", async () => {
    const ipc = createUpdateIpc({ isPackaged: false });

    const result = await invoke(
      ipc.harness,
      UpdateIpcChannel.CheckForUpdate,
      TRUSTED_EVENT
    );

    assert.deepEqual(result, DEV_CHECK_RESULT);
    assert.equal(ipc.checkForUpdates.mock.calls.length, 0);
  });

  test("a failing dev probe answers with an error payload, not a rejection", async () => {
    const ipc = createUpdateIpc({
      isPackaged: false,
      checkForUpdate: () => Promise.reject(new Error(CHECK_FAILURE_MESSAGE)),
    });

    const result = await invoke(
      ipc.harness,
      UpdateIpcChannel.CheckForUpdate,
      TRUSTED_EVENT
    );

    assert.deepEqual(result, {
      updateAvailable: false,
      error: CHECK_FAILURE_MESSAGE,
    });
    // The packaged error state belongs to packaged builds; recording it here
    // would leave a dev build claiming a broken updater it does not run.
    assert.equal(ipc.setPackagedUpdateState.mock.calls.length, 0);
    assert.equal(ipc.notifyPackagedUpdateStatus.mock.calls.length, 0);
  });
});

describe("check-for-update on a packaged build", () => {
  test("reports the state the updater events recorded without writing it", async () => {
    const result = feedResult(REMOTE_VERSION);
    const ipc = createUpdateIpc({
      isPackaged: true,
      checkForUpdates: () => Promise.resolve(result),
    });

    const payload = await invoke(
      ipc.harness,
      UpdateIpcChannel.CheckForUpdate,
      TRUSTED_EVENT
    );

    // FEA-2349: every checkForUpdates() result must be routed through the
    // download guard, or a rejected download promise lands as an unhandled one.
    assert.deepEqual(ipc.guardUpdateDownload.mock.calls, [[result]]);
    // ISS-10291: the state machine is the only writer. This probe emits no
    // updater event, so an `idle` payload is what the handler must hand back; a
    // write here would change the state without sending the banner.
    assert.equal(ipc.setPackagedUpdateState.mock.calls.length, 0);
    assert.deepEqual(payload, {
      status: "idle",
      updateAvailable: false,
      readyToInstall: false,
    });
  });

  test("a failing check records the error state and notifies, leaving the report to the error listener", async () => {
    const updateFailed = vi
      .spyOn(Observability, "electronUpdateFailed")
      .mockImplementation(() => undefined);
    const ipc = createUpdateIpc({
      isPackaged: true,
      checkForUpdates: () => Promise.reject(new Error(CHECK_FAILURE_MESSAGE)),
    });

    const payload = await invoke(
      ipc.harness,
      UpdateIpcChannel.CheckForUpdate,
      TRUSTED_EVENT
    );

    // electron-updater emits `error` before it rejects (AppUpdater.js:271), and
    // that listener already sent check_failed; a second one here double-counts.
    assert.equal(ipc.updateTelemetry.checkFailed.mock.calls.length, 0);
    assert.equal(updateFailed.mock.calls.length, 0);
    assert.equal(ipc.notifyPackagedUpdateStatus.mock.calls.length, 1);
    assert.deepEqual(payload, {
      status: "error",
      updateAvailable: false,
      readyToInstall: false,
      error: CHECK_FAILURE_MESSAGE,
    });
  });
});

describe("check-for-update over an update already in flight (ISS-11447)", () => {
  test("a failing check leaves a downloaded update ready to install", async () => {
    const ipc = createUpdateIpc({
      isPackaged: true,
      initialState: {
        status: "downloaded",
        available: true,
        downloaded: true,
        version: REMOTE_VERSION,
      },
      checkForUpdates: () => Promise.reject(new Error(CHECK_FAILURE_MESSAGE)),
    });

    const payload = await invoke(
      ipc.harness,
      UpdateIpcChannel.CheckForUpdate,
      TRUSTED_EVENT
    );

    assert.deepEqual(payload, {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: REMOTE_VERSION,
    });
    assert.equal(ipc.notifyPackagedUpdateStatus.mock.calls.length, 0);
    assert.equal(ipc.updateTelemetry.checkFailed.mock.calls.length, 0);
  });
});

describe("check-for-update under the FEA-2099 fake update feed", () => {
  test("probes the packaged feed, not the dev probe", async () => {
    vi.stubEnv(FAKE_UPDATE_FEED_ENV, FEED_URL);
    const ipc = createUpdateIpc({
      isPackaged: false,
      initialState: downloadedState(),
      checkForUpdates: () => Promise.resolve(feedResult(REMOTE_VERSION)),
    });

    const payload = await invoke(
      ipc.harness,
      UpdateIpcChannel.CheckForUpdate,
      TRUSTED_EVENT
    );

    assert.deepEqual(payload, {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: REMOTE_VERSION,
    });
    // The launched-app spec drives a real renderer check through this seam
    // (ISS-10291); the dev probe is what this unpackaged build would otherwise
    // have fallen through to.
    assert.equal(ipc.checkForUpdates.mock.calls.length, 1);
    assert.equal(ipc.checkForUpdate.mock.calls.length, 0);
  });
});

describe("apply-update", () => {
  test("refuses to quit a packaged build whose update is not downloaded", async () => {
    const ipc = createUpdateIpc({
      isPackaged: true,
      initialState: { status: "available", available: true, downloaded: false },
    });

    await assert.rejects(
      () => invoke(ipc.harness, UpdateIpcChannel.ApplyUpdate, TRUSTED_EVENT),
      new Error(PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE)
    );
    // Quitting here strands the user on a restart that installs nothing.
    assert.equal(electronAppQuitCallCount(), 0);
    assert.equal(ipc.setApplyingDownloadedUpdate.mock.calls.length, 0);
    assert.equal(ipc.updateTelemetry.installStarted.mock.calls.length, 0);
  });

  test("a downloaded packaged update is marked applying, reported, then quit", async () => {
    const ipc = createUpdateIpc({
      isPackaged: true,
      initialState: downloadedState(),
    });

    await invoke(ipc.harness, UpdateIpcChannel.ApplyUpdate, TRUSTED_EVENT);

    assert.deepEqual(ipc.setApplyingDownloadedUpdate.mock.calls, [[true]]);
    assert.deepEqual(ipc.updateTelemetry.installStarted.mock.calls, [
      [REMOTE_VERSION],
    ]);
    // FEA-2026: a graceful quit, so the before-quit handler runs shutdown
    // cleanup and hands the install to the updater. The dev apply path must not
    // also run — that pairing is what left the renderer stuck on "Restarting…".
    assert.equal(electronAppQuitCallCount(), 1);
    assert.equal(ipc.applyUpdate.mock.calls.length, 0);
  });

  test("an unpackaged build takes the dev apply path and does not quit", async () => {
    const ipc = createUpdateIpc({
      isPackaged: false,
      initialState: downloadedState(),
    });

    await invoke(ipc.harness, UpdateIpcChannel.ApplyUpdate, TRUSTED_EVENT);

    assert.equal(ipc.applyUpdate.mock.calls.length, 1);
    assert.equal(electronAppQuitCallCount(), 0);
  });
});

beforeEach(() => {
  // The fake-feed seam is env-keyed and its cases opt IN; an inherited value
  // would silently reroute every packaged/unpackaged case through it.
  vi.stubEnv(FAKE_UPDATE_FEED_ENV, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetElectronModuleStub();
});

/** A packaged state whose update is downloaded and ready to install. */
function downloadedState(): Partial<PackagedUpdateState> {
  return {
    status: "downloaded",
    available: true,
    downloaded: true,
    version: REMOTE_VERSION,
  };
}

/**
 * The minimum `checkForUpdates()` answer the handler reads: it takes
 * `updateInfo.version` and hands the whole result to the download guard.
 */
function feedResult(version: string): UpdateCheckResult {
  const updateInfo: UpdateInfo = {
    version,
    files: [],
    path: "",
    sha512: "",
    releaseDate: "2026-01-01T00:00:00.000Z",
  };
  return { isUpdateAvailable: true, updateInfo, versionInfo: updateInfo };
}

/**
 * Register the REAL handlers against a fake registrar, over live packaged state
 * so a write the handler performs is visible in the payload it then returns.
 */
function createUpdateIpc(options: UpdateHarnessOptions = {}) {
  setElectronAppIsPackaged(options.isPackaged ?? false);

  let state = mergePackagedUpdateState(
    createInitialPackagedUpdateState(),
    options.initialState ?? {}
  );
  const setPackagedUpdateState = vi.fn(
    (patch: Partial<PackagedUpdateState>) => {
      state = mergePackagedUpdateState(state, patch);
    }
  );
  const checkForUpdates = vi.fn(
    options.checkForUpdates ?? (() => Promise.resolve(null))
  );
  const checkForUpdate = vi.fn(
    options.checkForUpdate ?? (() => Promise.resolve(DEV_CHECK_RESULT))
  );
  const guardUpdateDownload = vi.fn();
  const notifyPackagedUpdateStatus = vi.fn();
  const setApplyingDownloadedUpdate = vi.fn();
  const applyUpdate = vi.fn(() => Promise.resolve());
  const updateTelemetry = createUpdateTelemetryDouble();

  const harness = createIpcRegistrar();
  registerUpdateIpcHandlers(harness.registrar, {
    isTrustedSender: isTrustedSenderDouble,
    getPackagedUpdateState: () => state,
    setPackagedUpdateState,
    getPackagedUpdateStatusPayload: () => toPackagedUpdateStatusPayload(state),
    checkForUpdates,
    guardUpdateDownload,
    checkForUpdate,
    notifyPackagedUpdateStatus,
    setApplyingDownloadedUpdate,
    applyUpdate,
    updateTelemetry,
  });

  return {
    applyUpdate,
    checkForUpdate,
    checkForUpdates,
    guardUpdateDownload,
    harness,
    notifyPackagedUpdateStatus,
    setApplyingDownloadedUpdate,
    setPackagedUpdateState,
    updateTelemetry,
  };
}

/**
 * Invoke a channel as a promise. The handlers are `async`, so a refusal arrives
 * as a rejection rather than a throw, and `assert.rejects` needs it typed.
 */
function invoke(
  harness: IpcRegistrarHarness,
  channel: UpdateIpcChannel,
  event: unknown
): Promise<unknown> {
  return Promise.resolve(harness.invoke(channel, event));
}
