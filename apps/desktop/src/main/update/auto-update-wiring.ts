import { app } from "electron";
import pkg from "electron-updater";
import { gatewayLog, isNetworkError } from "../logging/gateway-logger.js";
import { electronLog } from "../logging/persistent-log.js";
import { Observability } from "../telemetry/observability.js";
import {
  configureFakeUpdateFeed,
  getFakeUpdateFeedUrl,
  isFakeUpdateFeedActive,
  isPackagedUpdateFlowActive,
} from "./fake-update-feed.js";
import type { PackagedUpdateState } from "./packaged-update-state.js";
import {
  isAppTranslocated,
  isReadOnlyVolumeUpdateError,
} from "./update-install-blocked.js";

const { autoUpdater } = pkg;

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The application state the update lane reads and drives. Every accessor is a
 * getter/setter rather than a captured value so the handlers observe the live
 * packaged-update state the application owns, exactly as the previous inline
 * `this.…` calls did.
 */
export type DesktopUpdateWiringDeps = {
  getPackagedUpdateState: () => PackagedUpdateState;
  setPackagedUpdateState: (patch: Partial<PackagedUpdateState>) => void;
  notifyPackagedUpdateStatus: () => void;
  handleUpdateInstallBlocked: (version?: string) => void;
  guardUpdateDownload: (
    result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
  ) => void;
  sendUpdateAvailableToRenderer: (payload: {
    updateAvailable: boolean;
    version: string;
    readyToInstall: boolean;
  }) => void;
  /** Dev-mode (unpackaged) update probe: origin/main vs the built commit. */
  checkForUpdate: () => Promise<{ updateAvailable: boolean }>;
  notifyRendererDevUpdateReady: () => void;
  getUpdateCheckTimer: () => NodeJS.Timeout | null;
  setUpdateCheckTimer: (timer: NodeJS.Timeout) => void;
};

/** Whether the packaged updater must skip download/staging, and why. */
type PackagedUpdateFeedState = {
  updateInstallBlocked: boolean;
  fakeFeedActive: boolean;
};

/**
 * Start the app's update lane: the packaged electron-updater flow when the
 * packaged path is active, otherwise the dev-mode git-based update nudge. Both
 * arms arm a recurring `UPDATE_CHECK_INTERVAL_MS` poll, replacing any prior
 * timer.
 */
export function startDesktopUpdateChecks(deps: DesktopUpdateWiringDeps): void {
  if (isPackagedUpdateFlowActive(app.isPackaged)) {
    const feedState = configurePackagedUpdateFeed();
    registerPackagedUpdaterEvents(deps, feedState);
    checkForPackagedUpdatesNow(deps);
    schedulePackagedUpdatePolling(deps);
    return;
  }
  checkForDevUpdateNow(deps);
  scheduleDevUpdatePolling(deps);
}

/**
 * Apply the packaged updater's download/staging policy for this launch and
 * report which guards ended up active.
 */
function configurePackagedUpdateFeed(): PackagedUpdateFeedState {
  autoUpdater.logger = electronLog;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // FEA-2349: under macOS App Translocation the bundle runs from a
  // read-only mount, so Squirrel.Mac staging can only fail. Keep the
  // update *check* (the user should still learn a new version exists)
  // but skip download/staging and surface a "move to /Applications"
  // message instead — see the update-available handler below.
  const updateInstallBlocked = isAppTranslocated(
    process.platform,
    process.execPath
  );
  if (updateInstallBlocked) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    gatewayLog.warn(
      "auto-update",
      "App is translocated (read-only volume); update install disabled until the app is moved to /Applications"
    );
  }
  // FEA-2099 test seam: in an unpackaged e2e run, redirect the updater at
  // its generic provider to a localhost fixture feed so the
  // check→download→ready→handoff lifecycle is exercised without a real
  // release server or signing. No-op (and unreachable) in packaged builds.
  // isFakeUpdateFeedActive() is the SSOT for the unpackaged+env gate
  // (shared with finishUpdateInstall and the apply IPC); fakeFeedUrl is
  // only non-null in that same state, so the `!== null` narrowing below
  // is a type guard, not a second predicate.
  const fakeFeedUrl = getFakeUpdateFeedUrl();
  const fakeFeedActive = isFakeUpdateFeedActive(app.isPackaged);
  if (fakeFeedActive && fakeFeedUrl !== null) {
    configureFakeUpdateFeed(autoUpdater, fakeFeedUrl);
    // The fixture artifact is unsigned and OS-agnostic; never let the
    // native updater (MacUpdater/NsisUpdater/AppImageUpdater) attempt to
    // stage it. The real check + `update-available` event still fire
    // against the fixture feed (proving the generic-provider wiring); the
    // download→ready transition is then driven deterministically below so
    // the test is hermetic across OSes without depending on a successful
    // native binary download.
    // autoInstallOnAppQuit is already disabled inside
    // configureFakeUpdateFeed(); only autoDownload needs setting here.
    autoUpdater.autoDownload = false;
    gatewayLog.info(
      "auto-update",
      `Fake update feed active url=${fakeFeedUrl} (e2e seam)`
    );
  }
  return { updateInstallBlocked, fakeFeedActive };
}

/** The updater's error channel: the state + telemetry path for a failed check. */
function registerPackagedUpdaterErrorHandler(
  deps: DesktopUpdateWiringDeps
): void {
  autoUpdater.on("error", (err) => {
    const level = isNetworkError(err.message) ? "debug" : "error";
    gatewayLog[level]("auto-update", `Auto-update error: ${err.message}`);
    if (isReadOnlyVolumeUpdateError(err.message)) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      deps.handleUpdateInstallBlocked(deps.getPackagedUpdateState().version);
      return;
    }
    deps.setPackagedUpdateState({
      status: "error",
      available: false,
      downloaded: false,
      error: err.message,
      percent: undefined,
    });
    deps.notifyPackagedUpdateStatus();
    const state = deps.getPackagedUpdateState();
    Observability.electronUpdateFailed({
      trigger: "updater-error",
      status: state.status,
      version: state.version,
      error: err.message,
      downloaded: state.downloaded,
      readyToInstall: state.downloaded,
    });
  });
}

/** The available → downloading → downloaded → not-available state machine. */
function registerPackagedUpdaterEvents(
  deps: DesktopUpdateWiringDeps,
  feedState: PackagedUpdateFeedState
): void {
  registerPackagedUpdaterErrorHandler(deps);
  autoUpdater.on("update-available", (info) => {
    if (feedState.updateInstallBlocked && !feedState.fakeFeedActive) {
      // FEA-2349: no download will follow (autoDownload is off), so a
      // "downloading" banner would mislead. Surface the actionable
      // error state and tell the user how to self-resolve.
      deps.handleUpdateInstallBlocked(info.version);
      return;
    }
    deps.setPackagedUpdateState({
      status: "available",
      available: true,
      downloaded: false,
      version: info.version,
      error: undefined,
      percent: undefined,
    });
    gatewayLog.info(
      "auto-update",
      `Update available version=${info.version}; waiting for download`
    );
    deps.notifyPackagedUpdateStatus();
    deps.sendUpdateAvailableToRenderer({
      updateAvailable: true,
      version: info.version,
      readyToInstall: false,
    });
    if (feedState.fakeFeedActive) {
      // Deterministically advance to "downloaded" so the e2e can drive
      // apply → finishUpdateInstall without a flaky native download.
      deps.setPackagedUpdateState({
        status: "downloaded",
        available: true,
        downloaded: true,
        version: info.version,
        percent: 100,
        error: undefined,
      });
      gatewayLog.info(
        "auto-update",
        `fake-feed: marked downloaded version=${info.version}`
      );
      deps.notifyPackagedUpdateStatus();
    }
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent =
      typeof progress.percent === "number"
        ? Math.max(0, Math.min(100, progress.percent))
        : undefined;
    deps.setPackagedUpdateState({
      status: "downloading",
      available: true,
      downloaded: false,
      percent,
      error: undefined,
    });
    gatewayLog.debug(
      "auto-update",
      () =>
        `Update download progress version=${deps.getPackagedUpdateState().version ?? "unknown"} percent=${percent?.toFixed(1) ?? "unknown"}`
    );
    deps.notifyPackagedUpdateStatus();
  });
  autoUpdater.on("update-downloaded", (info) => {
    deps.setPackagedUpdateState({
      status: "downloaded",
      available: true,
      downloaded: true,
      version: info.version,
      percent: 100,
      error: undefined,
    });
    gatewayLog.info(
      "auto-update",
      `Update downloaded version=${info.version}; ready to restart`
    );
    deps.notifyPackagedUpdateStatus();
  });
  autoUpdater.on("update-not-available", (info) => {
    deps.setPackagedUpdateState({
      status: "not-available",
      available: false,
      downloaded: false,
      version: info.version,
      percent: undefined,
      error: undefined,
    });
    gatewayLog.debug(
      "auto-update",
      () => `No packaged update available version=${info.version ?? "unknown"}`
    );
    deps.notifyPackagedUpdateStatus();
  });
}

/**
 * The boot-time packaged check. A failure is a first-class error state (the
 * banner shows it) plus one telemetry event — never an unhandled rejection.
 */
function checkForPackagedUpdatesNow(deps: DesktopUpdateWiringDeps): void {
  autoUpdater
    .checkForUpdates()
    .then((result) => deps.guardUpdateDownload(result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      gatewayLog.error("auto-update", `Failed to check for updates: ${msg}`);
      deps.setPackagedUpdateState({
        status: "error",
        available: false,
        downloaded: false,
        error: msg,
        percent: undefined,
      });
      deps.notifyPackagedUpdateStatus();
      const state = deps.getPackagedUpdateState();
      Observability.electronUpdateFailed({
        trigger: "check-for-updates",
        status: state.status,
        version: state.version,
        error: msg,
        downloaded: state.downloaded,
        readyToInstall: state.downloaded,
      });
    });
}

/** Recurring packaged poll. A poll failure is debug-only (the boot check owns the banner). */
function schedulePackagedUpdatePolling(deps: DesktopUpdateWiringDeps): void {
  clearExistingUpdateCheckTimer(deps);
  deps.setUpdateCheckTimer(
    setInterval(() => {
      autoUpdater
        .checkForUpdates()
        .then((result) => deps.guardUpdateDownload(result))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          gatewayLog.debug(
            "auto-update",
            `Failed to check for updates: ${msg}`
          );
        });
    }, UPDATE_CHECK_INTERVAL_MS)
  );
}

/** Dev-mode boot probe: nudge the renderer when origin/main is ahead. */
function checkForDevUpdateNow(deps: DesktopUpdateWiringDeps): void {
  deps
    .checkForUpdate()
    .then((result) => {
      if (result.updateAvailable) {
        deps.notifyRendererDevUpdateReady();
      }
    })
    .catch(() => {
      // Dev-only nudge; a failed git probe is not worth surfacing.
    });
}

/** Recurring dev-mode poll on the same interval as the packaged path. */
function scheduleDevUpdatePolling(deps: DesktopUpdateWiringDeps): void {
  clearExistingUpdateCheckTimer(deps);
  deps.setUpdateCheckTimer(
    setInterval(() => {
      deps
        .checkForUpdate()
        .then((result) => {
          if (result.updateAvailable) {
            deps.notifyRendererDevUpdateReady();
          }
        })
        .catch(() => {
          // Dev-only nudge; a failed git probe is not worth surfacing.
        });
    }, UPDATE_CHECK_INTERVAL_MS)
  );
}

/** Replace any prior poll so re-entering the update lane cannot leak a timer. */
function clearExistingUpdateCheckTimer(deps: DesktopUpdateWiringDeps): void {
  const existing = deps.getUpdateCheckTimer();
  if (existing) {
    clearInterval(existing);
  }
}
