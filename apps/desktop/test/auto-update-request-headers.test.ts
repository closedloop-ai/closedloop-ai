/**
 * @file auto-update-request-headers.test.ts
 * @description ISS-9164 — the compute-target id this install sends on updater
 * requests, so the API can resolve a release ring for it (PRD-707 FR3).
 *
 * WHY THIS FILE EXISTS RATHER THAN AN ASSERTION SOMEWHERE ELSE. The header set is
 * built by a pure helper in `@repo/api`, which its own suite covers; what cannot
 * be covered there is that the packaged updater actually stamps it, and stamps it
 * before EVERY check rather than once at wiring time. A compute target is
 * hello-derived and null for the first seconds of a launch, so a one-shot read
 * would leave every install permanently unringed with every unit test still green.
 *
 * The MANUAL check sites (the gateway action, the renderer IPC) reach the same
 * exported seam since #6867, and `requestHeaders` is one sticky property on the
 * singleton, so what they inherit when they do not re-stamp is pinned here too.
 * That they reach it at all is `updater-check-seam-wiring.test.ts`.
 *
 * That one sticky property is also read by the DOWNLOAD, which follows a
 * cross-origin 302 to the release host, so the last block pins what a download
 * can still see: the client version, never the compute-target id. The e2e
 * (`test/e2e/auto-update-flow.spec.ts`) pins the other end — the header names as
 * a real electron-updater check puts them on the wire.
 *
 * The last block is ISS-10291: an update a check in that same window finds must
 * reach the state machine, its telemetry and the renderer banner, not only the
 * narrowing.
 *
 * `electron-updater` is module-mocked. ISS-4514 recorded that its `MacUpdater`
 * touches `require("electron").autoUpdater` at construction, which is why nothing
 * imported this wiring before; the mock is what keeps this import off that path.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { DesktopUpdateWiringDeps } from "../src/main/update/auto-update-wiring.js";
import { FAKE_UPDATE_FEED_ENV } from "../src/main/update/fake-update-feed.js";
import {
  createInitialPackagedUpdateState,
  mergePackagedUpdateState,
  toPackagedUpdateStatusPayload,
} from "../src/main/update/packaged-update-state.js";
import {
  INITIAL_UPDATE_BANNER_STATE,
  isUpdateApplyEnabled,
  isUpdateBannerVisible,
  reduceUpdateAvailableEvent,
  reduceUpdateStatusEvent,
} from "../src/renderer/components/update-banner-state.js";
import {
  resetElectronModuleStub,
  STUB_APP_VERSION,
  setElectronAppIsPackaged,
} from "./helpers/electron-module-stub.js";
import { createUpdateTelemetryDouble } from "./helpers/update-telemetry-double.js";

/** Written out, never read off the contract module: these are the wire spellings. */
const COMPUTE_TARGET_ID_HEADER = "x-desktop-compute-target-id";
const CLIENT_VERSION_HEADER = "x-desktop-client-version";
const COMPUTE_TARGET_ID = "01a06a86-56fa-7213-ae2d-3f5fe0932ec5";
const SECOND_COMPUTE_TARGET_ID = "01a06a87-4bbd-71ff-b6a4-c259f8073bba";
const FAKE_FEED_URL = "http://127.0.0.1:65535/fake-feed";
/** Past the wiring's five-minute poll interval. */
const PAST_ONE_POLL_MS = 5 * 60 * 1000 + 1;
/** Distinguishes "never stamped" from "stamped with an empty set". */
const NEVER_STAMPED = Symbol("never stamped");
/** A header the updater contract has never classified (ISS-9790). */
const UNCLASSIFIED_HEADER = "x-desktop-future-header";

const autoUpdaterStub = {
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  forceDevUpdateConfig: false,
  requestHeaders: NEVER_STAMPED as unknown,
  on: vi.fn(),
  /**
   * Backed by the recorded `on` calls, because ISS-10127's narrowing installs
   * itself only when the emitter does not already hold it. A stub that always
   * answered `[]` would report that guard as working while every poll silently
   * re-registered, which is the shape the real singleton would accumulate.
   */
  listeners: vi.fn((event: string) =>
    autoUpdaterStub.on.mock.calls
      .filter(([name]) => name === event)
      .map(([, handler]) => handler)
  ),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve(null)),
};

vi.mock("electron-updater", () => ({
  default: { autoUpdater: autoUpdaterStub },
  autoUpdater: autoUpdaterStub,
}));

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

const { checkForStampedUpdates, installDesktopUpdateLane } = await import(
  "../src/main/update/auto-update-wiring.js"
);

let timers: NodeJS.Timeout[] = [];

type WiringHarnessOptions = {
  isPackaged?: boolean;
  fakeFeed?: boolean;
  getComputeTargetId?: () => string | null;
};

/** Install the lane and start its checks, as the constructor and then boot do. */
function startWiring(options: WiringHarnessOptions = {}) {
  setElectronAppIsPackaged(options.isPackaged ?? true);
  if (options.fakeFeed === true) {
    process.env[FAKE_UPDATE_FEED_ENV] = FAKE_FEED_URL;
  }
  const lane = wiringDeps(options.getComputeTargetId);
  installDesktopUpdateLane(lane.deps)();
  return lane;
}

/**
 * Deps over a live packaged-update state and a live renderer banner: each
 * renderer send is fed through the banner's own reducer, as the preload bridge
 * delivers it, so a case can read what an updater event did to both.
 */
function wiringDeps(
  getComputeTargetId: () => string | null = () => COMPUTE_TARGET_ID
) {
  let state = createInitialPackagedUpdateState();
  let banner = INITIAL_UPDATE_BANNER_STATE;
  const telemetry = createUpdateTelemetryDouble();
  const checkForUpdate = vi.fn(() =>
    Promise.resolve({ updateAvailable: false })
  );
  const deps: DesktopUpdateWiringDeps = {
    getPackagedUpdateState: () => state,
    setPackagedUpdateState: (patch) => {
      state = mergePackagedUpdateState(state, patch);
    },
    notifyPackagedUpdateStatus: () => {
      banner = reduceUpdateStatusEvent(
        banner,
        toPackagedUpdateStatusPayload(state)
      );
    },
    handleUpdateInstallBlocked: vi.fn(),
    guardUpdateDownload: vi.fn(),
    sendUpdateAvailableToRenderer: (payload) => {
      banner = reduceUpdateAvailableEvent(banner, payload);
    },
    checkForUpdate,
    getComputeTargetId,
    notifyRendererDevUpdateReady: vi.fn(),
    getUpdateCheckTimer: () => null,
    setUpdateCheckTimer: (timer) => {
      timers.push(timer);
    },
    updateTelemetry: telemetry,
  };
  return {
    deps,
    checkForUpdate,
    telemetry,
    readState: () => state,
    readBanner: () => banner,
  };
}

/** The headers actually stamped on the updater, or the never-stamped sentinel. */
function stampedHeaders(): Record<string, string> | typeof NEVER_STAMPED {
  return autoUpdaterStub.requestHeaders as
    | Record<string, string>
    | typeof NEVER_STAMPED;
}

beforeEach(() => {
  resetElectronModuleStub();
  autoUpdaterStub.requestHeaders = NEVER_STAMPED;
  autoUpdaterStub.autoDownload = false;
  autoUpdaterStub.autoInstallOnAppQuit = false;
  autoUpdaterStub.forceDevUpdateConfig = false;
  autoUpdaterStub.on.mockClear();
  autoUpdaterStub.setFeedURL.mockClear();
  autoUpdaterStub.checkForUpdates.mockClear();
  Reflect.deleteProperty(process.env, FAKE_UPDATE_FEED_ENV);
});

afterEach(() => {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers = [];
  // Unconditional, and not the last line of the one case that installs them: a
  // failed assertion between install and restore would otherwise leak a frozen
  // clock into every later file in this worker.
  vi.useRealTimers();
  Reflect.deleteProperty(process.env, FAKE_UPDATE_FEED_ENV);
  resetElectronModuleStub();
});

describe("packaged updater request headers", () => {
  test("stamps the compute-target id and the client version on the boot check", () => {
    startWiring({ isPackaged: true });

    assert.deepEqual(stampedHeaders(), {
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
    assert.equal(autoUpdaterStub.checkForUpdates.mock.calls.length, 1);
  });

  test("stamps no compute-target id when this install has none", () => {
    startWiring({ isPackaged: true, getComputeTargetId: () => null });

    const headers = stampedHeaders();
    assert.notEqual(headers, NEVER_STAMPED);
    assert.deepEqual(headers, { [CLIENT_VERSION_HEADER]: STUB_APP_VERSION });
  });

  test("re-reads the compute target on the poll rather than caching the boot value", () => {
    vi.useFakeTimers();
    let current: string | null = null;

    startWiring({ isPackaged: true, getComputeTargetId: () => current });
    assert.deepEqual(stampedHeaders(), {
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });

    current = SECOND_COMPUTE_TARGET_ID;
    vi.advanceTimersByTime(PAST_ONE_POLL_MS);

    assert.deepEqual(stampedHeaders(), {
      [COMPUTE_TARGET_ID_HEADER]: SECOND_COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
    assert.equal(autoUpdaterStub.checkForUpdates.mock.calls.length, 2);
  });

  test("still checks for updates when resolving the compute target throws", () => {
    startWiring({
      isPackaged: true,
      getComputeTargetId: () => {
        throw new Error("store not ready");
      },
    });

    assert.deepEqual(stampedHeaders(), {
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
    assert.equal(autoUpdaterStub.checkForUpdates.mock.calls.length, 1);
  });
});

describe("unpackaged wiring paths", () => {
  test("stamps the same headers on the unpackaged fake-feed path", () => {
    startWiring({ isPackaged: false, fakeFeed: true });

    assert.deepEqual(stampedHeaders(), {
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
  });

  test("leaves the fake-feed seam itself unchanged", () => {
    startWiring({ isPackaged: false, fakeFeed: true });

    assert.deepEqual(autoUpdaterStub.setFeedURL.mock.calls, [
      [{ provider: "generic", url: FAKE_FEED_URL }],
    ]);
    assert.equal(autoUpdaterStub.forceDevUpdateConfig, true);
    assert.equal(autoUpdaterStub.autoDownload, false);
    assert.equal(autoUpdaterStub.autoInstallOnAppQuit, false);
  });

  test("stamps nothing on the dev git-probe path, which reaches no feed", () => {
    const { checkForUpdate } = startWiring({
      isPackaged: false,
      fakeFeed: false,
    });

    assert.equal(stampedHeaders(), NEVER_STAMPED);
    assert.equal(autoUpdaterStub.checkForUpdates.mock.calls.length, 0);
    assert.equal(checkForUpdate.mock.calls.length, 1);
  });
});

describe("manual checks routed through the same seam", () => {
  test("a manual check re-stamps rather than inheriting the boot check's headers", async () => {
    // The launch a user hits "Check for updates" during: the boot check ran
    // before the first hello, so the singleton is holding version-only headers.
    let current: string | null = null;
    startWiring({ isPackaged: true, getComputeTargetId: () => current });
    assert.deepEqual(stampedHeaders(), {
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });

    current = SECOND_COMPUTE_TARGET_ID;
    await checkForStampedUpdates(() => current);

    assert.deepEqual(stampedHeaders(), {
      [COMPUTE_TARGET_ID_HEADER]: SECOND_COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
    assert.equal(autoUpdaterStub.checkForUpdates.mock.calls.length, 2);
  });

  test("a manual check drops a target that has gone away", async () => {
    startWiring({ isPackaged: true });
    assert.deepEqual(stampedHeaders(), {
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });

    // Signing out leaves the id on the singleton until something re-stamps it,
    // which is the same stickiness read from the other end.
    await checkForStampedUpdates(() => null);

    assert.deepEqual(stampedHeaders(), {
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
  });
});

describe("headers a cross-origin download can receive", () => {
  test("the compute-target id is off the shared property before a download reads it", () => {
    startWiring({ isPackaged: true });

    // Positive control on the same mechanism: the id really was stamped, so the
    // absence asserted below is a removal and not an empty pipe.
    assert.deepEqual(stampedHeaders(), {
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });

    emitUpdateAvailable();

    // What `AppUpdater.computeRequestHeaders` reads at `:463` when the download
    // starts — after the synchronous `update-available` emit at `:414`/`:429`.
    assert.deepEqual(stampedHeaders(), {
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
  });

  test("narrowing does not depend on the state-machine handler running", () => {
    startWiring({ isPackaged: true });

    // Only the FIRST `update-available` listener, so an early return in the
    // state-machine handler registered after it cannot leave the id stamped.
    const [narrowing] = updateAvailableHandlers();
    narrowing(UPDATE_AVAILABLE_INFO);

    assert.deepEqual(stampedHeaders(), {
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
  });

  test("a header nothing classified never reaches the download leg", () => {
    startWiring({ isPackaged: true });

    // The case no `Record<keyof T, …>` can see: a header put straight onto the
    // singleton, bypassing the contract that classifies them. Positive control
    // first — it really is on the property the download would read.
    autoUpdaterStub.requestHeaders = {
      [UNCLASSIFIED_HEADER]: "whatever-the-next-person-adds",
    };
    assert.deepEqual(stampedHeaders(), {
      [UNCLASSIFIED_HEADER]: "whatever-the-next-person-adds",
    });

    emitUpdateAvailable();

    // Empty, not a rebuilt `{client-version}` set. The download leg forwards the
    // classified subset of what was actually stamped; it neither passes an
    // unclassified header through nor invents one that was never there.
    assert.deepEqual(stampedHeaders(), {});
  });

  test("the next check re-rings the feed rather than staying narrowed", async () => {
    startWiring({ isPackaged: true });
    emitUpdateAvailable();
    assert.deepEqual(stampedHeaders(), {
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });

    await checkForStampedUpdates(() => SECOND_COMPUTE_TARGET_ID);

    assert.deepEqual(stampedHeaders(), {
      [COMPUTE_TARGET_ID_HEADER]: SECOND_COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
  });
});

describe("a check issued before the boot wiring has run", () => {
  test("installs the narrowing itself rather than downloading unprotected", async () => {
    // ISS-10127's window, constructed. The renderer's check-for-updates IPC is
    // wired in the DesktopApplication constructor; the boot wiring that used to
    // be the only installer runs much later, after the window exists. Nothing
    // here installs the update lane, which is the whole point — a check
    // arriving in that interval used to find no listener at all, and
    // autoDownload is on by default.
    await checkForStampedUpdates(() => COMPUTE_TARGET_ID);

    // Two positive controls, because both halves of the drive below can be
    // vacuous: the id really is on the property the download reads, AND a
    // listener really is installed, so the emit is not a loop over nothing that
    // would satisfy any absence.
    assert.deepEqual(stampedHeaders(), {
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
    assert.ok(
      updateAvailableHandlers().length > 0,
      "the check installed no update-available listener, so autoDownload would carry the stamped id onto the cross-origin download"
    );

    emitUpdateAvailable();

    assert.deepEqual(stampedHeaders(), {
      [CLIENT_VERSION_HEADER]: STUB_APP_VERSION,
    });
  });

  test("adds no listener the boot wiring or a later poll would duplicate", async () => {
    startWiring({ isPackaged: true });
    const afterBoot = updateAvailableHandlers().length;
    assert.ok(afterBoot > 0, "the boot wiring registered no listener at all");

    await checkForStampedUpdates(() => COMPUTE_TARGET_ID);
    await checkForStampedUpdates(() => SECOND_COMPUTE_TARGET_ID);

    // `autoUpdater` is a process-lifetime singleton and the poll runs every five
    // minutes, so an installer that did not ask the emitter first would leak a
    // listener per check and still pass every header assertion in this file.
    assert.equal(updateAvailableHandlers().length, afterBoot);
  });
});

describe("an update found before boot starts the checks (ISS-10291)", () => {
  test("reaches the state machine, its telemetry and the banner", async () => {
    setElectronAppIsPackaged(true);
    const lane = wiringDeps();
    // The constructor's half only: boot has not started the checks yet.
    installDesktopUpdateLane(lane.deps);
    assert.equal(autoUpdaterStub.checkForUpdates.mock.calls.length, 0);

    // The renderer's check in that window. electron-updater emits
    // `update-available` synchronously inside the check, before it resolves.
    autoUpdaterStub.checkForUpdates.mockImplementationOnce(() => {
      emitUpdaterEvent("update-available", UPDATE_AVAILABLE_INFO);
      return Promise.resolve(null);
    });
    await checkForStampedUpdates(() => COMPUTE_TARGET_ID);

    assert.equal(lane.readState().status, "available");
    assert.deepEqual(lane.telemetry.available.mock.calls, [
      [UPDATE_AVAILABLE_INFO.version],
    ]);
    assert.ok(isUpdateBannerVisible(lane.readBanner()));

    // The download that check started finishes before boot, too.
    emitUpdaterEvent("update-downloaded", UPDATE_AVAILABLE_INFO);

    assert.deepEqual(lane.telemetry.downloadSucceeded.mock.calls, [
      [UPDATE_AVAILABLE_INFO.version],
    ]);
    assert.ok(isUpdateApplyEnabled(lane.readBanner()));
    assert.equal(lane.readBanner().version, UPDATE_AVAILABLE_INFO.version);
  });

  test("an update the boot check finds reaches them exactly once", () => {
    autoUpdaterStub.checkForUpdates.mockImplementationOnce(() => {
      emitUpdaterEvent("update-available", UPDATE_AVAILABLE_INFO);
      return Promise.resolve(null);
    });
    const lane = startWiring({ isPackaged: true });
    emitUpdaterEvent("update-downloaded", UPDATE_AVAILABLE_INFO);

    // Once, not twice: starting the checks must not install a second state
    // machine over the one the constructor's half already installed.
    assert.deepEqual(lane.telemetry.available.mock.calls, [
      [UPDATE_AVAILABLE_INFO.version],
    ]);
    assert.deepEqual(lane.telemetry.downloadSucceeded.mock.calls, [
      [UPDATE_AVAILABLE_INFO.version],
    ]);
    assert.ok(isUpdateApplyEnabled(lane.readBanner()));
  });
});

/** The `update-available` payload the wiring's handlers read `version` off. */
const UPDATE_AVAILABLE_INFO = { version: "99.0.0" };

/** Every `update-available` listener the wiring registered, in registration order. */
function updateAvailableHandlers(): ((info: { version: string }) => void)[] {
  const handlers: ((info: { version: string }) => void)[] = [];
  for (const [event, handler] of autoUpdaterStub.on.mock.calls) {
    if (event === "update-available" && typeof handler === "function") {
      handlers.push(handler);
    }
  }
  return handlers;
}

/**
 * Drive the event electron-updater emits synchronously before it downloads.
 *
 * Registering none is not silently tolerated: the header assertions in the cases
 * above still see the check's stamped id and fail.
 */
function emitUpdateAvailable(): void {
  emitUpdaterEvent("update-available", UPDATE_AVAILABLE_INFO);
}

/** Run every listener the wiring registered for `event`, in registration order. */
function emitUpdaterEvent(event: string, payload: unknown): void {
  for (const [name, handler] of autoUpdaterStub.on.mock.calls) {
    if (name === event && typeof handler === "function") {
      handler(payload);
    }
  }
}
