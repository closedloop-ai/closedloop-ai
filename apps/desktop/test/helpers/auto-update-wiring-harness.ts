/**
 * @file auto-update-wiring-harness.ts
 * @description The harness the update-lane suites drive: a recording
 * `autoUpdater` double, the wiring deps over live state, the per-case reset and
 * restore, and the updater payloads more than one suite reads.
 */
import { vi } from "vitest";
import type { DesktopUpdateWiringDeps } from "../../src/main/update/auto-update-wiring.js";
import { FAKE_UPDATE_FEED_ENV } from "../../src/main/update/fake-update-feed.js";
import {
  createInitialPackagedUpdateState,
  mergePackagedUpdateState,
  type PackagedUpdateState,
  toPackagedUpdateStatusPayload,
} from "../../src/main/update/packaged-update-state.js";
import {
  INITIAL_UPDATE_BANNER_STATE,
  reduceUpdateStatusEvent,
} from "../../src/renderer/components/update-banner-state.js";
import { deferred } from "../deferred.js";
import {
  resetElectronModuleStub,
  setElectronAppIsPackaged,
} from "./electron-module-stub.js";
import { createUpdateTelemetryDouble } from "./update-telemetry-double.js";

export type UpdaterListener = (...payload: unknown[]) => void;

/** The recording `autoUpdater` double; a suite's `electron-updater` mock serves it. */
export const updater = (() => {
  const registrations: [string, UpdaterListener][] = [];
  const stub = {
    logger: null as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    forceDevUpdateConfig: false,
    requestHeaders: {} as Record<string, string>,
    on: vi.fn((event: string, handler: UpdaterListener) => {
      registrations.push([event, handler]);
      return stub;
    }),
    listeners: vi.fn((event: string) =>
      registrations
        .filter(([name]) => name === event)
        .map(([, handler]) => handler)
    ),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn((): Promise<unknown> => Promise.resolve(null)),
  };
  return { registrations, stub };
})();

export const COMPUTE_TARGET_ID = "01a06a86-56fa-7213-ae2d-3f5fe0932ec5";
const FAKE_FEED_URL = "http://127.0.0.1:65535/fake-feed";
const TRANSLOCATED_EXEC_PATH =
  "/private/var/folders/xy/AppTranslocation/ABCD/d/Closedloop.app/Contents/MacOS/Closedloop";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const originalExecPath = process.execPath;
const originalFakeFeed = process.env[FAKE_UPDATE_FEED_ENV];

/** Every interval a case armed, cleared by {@link restoreWiringHarness}. */
export const timers: NodeJS.Timeout[] = [];

export type HarnessOptions = {
  isPackaged?: boolean;
  fakeFeed?: boolean;
  translocated?: boolean;
  initialState?: PackagedUpdateState;
  devUpdateAvailable?: () => Promise<{ updateAvailable: boolean }>;
  existingTimer?: NodeJS.Timeout | null;
};

/**
 * The deps a suite hands `installDesktopUpdateLane`, over live state. Each
 * renderer notify is fed through the banner's own reducer, as the preload bridge
 * delivers it. Installing is the suite's, so this module never loads the wiring
 * (and with it `electron-updater`, whose mock serves {@link updater}).
 */
export function createWiringLane(options: HarnessOptions = {}) {
  setElectronAppIsPackaged(options.isPackaged ?? true);
  if (options.fakeFeed === true) {
    process.env[FAKE_UPDATE_FEED_ENV] = FAKE_FEED_URL;
  }
  if (options.translocated === true) {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    process.execPath = TRANSLOCATED_EXEC_PATH;
  }
  let state = options.initialState ?? createInitialPackagedUpdateState();
  let banner = INITIAL_UPDATE_BANNER_STATE;
  const telemetry = createUpdateTelemetryDouble();
  const downloadGuarded = deferred();
  const devUpdateNudged = deferred();
  const deps = {
    getPackagedUpdateState: () => state,
    setPackagedUpdateState: vi.fn((patch: Partial<PackagedUpdateState>) => {
      state = mergePackagedUpdateState(state, patch);
    }),
    notifyPackagedUpdateStatus: vi.fn(() => {
      banner = reduceUpdateStatusEvent(
        banner,
        toPackagedUpdateStatusPayload(state)
      );
    }),
    handleUpdateInstallBlocked: vi.fn(),
    guardUpdateDownload: vi.fn(() => {
      downloadGuarded.resolve();
    }),
    sendUpdateAvailableToRenderer: vi.fn(),
    checkForUpdate: vi.fn(
      options.devUpdateAvailable ??
        (() => Promise.resolve({ updateAvailable: false }))
    ),
    notifyRendererDevUpdateReady: vi.fn(() => {
      devUpdateNudged.resolve();
    }),
    getUpdateCheckTimer: () => options.existingTimer ?? null,
    setUpdateCheckTimer: vi.fn((timer: NodeJS.Timeout) => {
      timers.push(timer);
    }),
    getComputeTargetId: () => COMPUTE_TARGET_ID,
    updateTelemetry: telemetry,
  } satisfies DesktopUpdateWiringDeps;
  return {
    deps,
    telemetry,
    readState: () => state,
    readBanner: () => banner,
    downloadGuarded: downloadGuarded.promise,
    devUpdateNudged: devUpdateNudged.promise,
  };
}

/** Every listener registered for `event`, in registration order. */
export function handlersFor(event: string): UpdaterListener[] {
  return updater.registrations
    .filter(([name]) => name === event)
    .map(([, handler]) => handler);
}

export function emit(event: string, ...payload: unknown[]): void {
  for (const handler of handlersFor(event)) {
    handler(...payload);
  }
}

/** Per-case reset: a fresh updater double, electron stub and feed env. */
export function resetWiringHarness(): void {
  resetElectronModuleStub();
  updater.registrations.length = 0;
  updater.stub.requestHeaders = {};
  updater.stub.autoDownload = false;
  updater.stub.autoInstallOnAppQuit = false;
  updater.stub.forceDevUpdateConfig = false;
  updater.stub.on.mockClear();
  updater.stub.setFeedURL.mockClear();
  updater.stub.checkForUpdates.mockReset();
  updater.stub.checkForUpdates.mockImplementation(() => Promise.resolve(null));
  Reflect.deleteProperty(process.env, FAKE_UPDATE_FEED_ENV);
}

/** Per-case restore: intervals, mocks, and the process state a case rewrote. */
export function restoreWiringHarness(): void {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers.length = 0;
  vi.restoreAllMocks();
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  process.execPath = originalExecPath;
  if (originalFakeFeed === undefined) {
    Reflect.deleteProperty(process.env, FAKE_UPDATE_FEED_ENV);
  } else {
    process.env[FAKE_UPDATE_FEED_ENV] = originalFakeFeed;
  }
  resetElectronModuleStub();
}

export const OFFERED_VERSION = "99.0.0";
export const PAST_ONE_POLL_MS = 5 * 60 * 1000 + 1;
export const AUTO_UPDATE_TAG = "auto-update";
export const NETWORK_MESSAGE = "net::ERR_INTERNET_DISCONNECTED";
export const TIMED_OUT_MESSAGE = "net::ERR_TIMED_OUT";
/**
 * The two `error` details electron-updater 6.8.7 sends, spelled out rather than
 * read off the production prefix: a check failure (`AppUpdater.js:271`) and a
 * download failure (`dispatchError`, the bare stack).
 */
export const CHECK_FAILURE_DETAIL =
  "Cannot check for updates: Error: net::ERR_TIMED_OUT\n    at SimpleURLLoaderWrapper";
export const DOWNLOAD_FAILURE_DETAIL =
  "Error: net::ERR_TIMED_OUT\n    at SimpleURLLoaderWrapper";
