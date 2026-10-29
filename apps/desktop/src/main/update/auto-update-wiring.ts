import {
  buildDesktopUpdaterRequestHeaders,
  narrowDesktopUpdaterHeadersForRedirect,
} from "@repo/api/src/types/desktop-client-attribution";
import { app } from "electron";
import pkg from "electron-updater";
import { gatewayLog, isNetworkError } from "../logging/gateway-logger.js";
import { electronLog } from "../logging/persistent-log.js";
import { Observability } from "../telemetry/observability.js";
import { isDevUpdateCheckDisabled } from "./dev-update-check-gate.js";
import {
  configureFakeUpdateFeed,
  getFakeUpdateFeedUrl,
  isFakeUpdateFeedActive,
  isPackagedUpdateFlowActive,
} from "./fake-update-feed.js";
import {
  type BackgroundCheckFailureStreak,
  createBackgroundCheckFailureStreak,
  isCheckFailureOverInFlightUpdate,
  isUpdateCheckPhaseError,
  isUpdateDownloadPhaseError,
  isUpdateInFlight,
  type PackagedUpdateState,
} from "./packaged-update-state.js";
import {
  isAppTranslocated,
  isReadOnlyVolumeUpdateError,
} from "./update-install-blocked.js";
import type { DesktopUpdateLifecycleReporter } from "./update-lifecycle-telemetry.js";

const { autoUpdater } = pkg;

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Checks in flight from any caller but the recurring poll. electron-updater
 * shares one in-flight check between callers and emits its `error` once, so
 * this is what tells the listener whether the failed check was the poll's alone.
 */
let foregroundChecksInFlight = 0;

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
  /**
   * ISS-9164: the compute target this install writes under, so the updater feed
   * can resolve a release ring for it (PRD-707 FR3). Null on a singleplayer
   * install, before the first hello of a launch, and while signed out — all of
   * which the feed reads as the general ring.
   *
   * The signed-out null is a REQUIREMENT ON THE SUPPLIER, not an observation
   * (whitlockk, #6867). The sync lane's `computeTargetId` deliberately keeps
   * returning the live hello-derived id through the identity-null window, so
   * wiring this to it would stamp a signed-out install's prior target on an
   * unauthenticated request that has no session to scope it. Supply an
   * auth-aware accessor — `authenticatedComputeTargetId`.
   */
  getComputeTargetId: () => string | null;
  /**
   * ISS-7247. Separate from the `Observability.electronUpdate*` calls beside it:
   * those are auth-gated diagnostics carrying raw error text; this is the
   * keyless lane `app.lifecycle.event` rides, the only one the post-restart
   * verification can be joined against.
   */
  updateTelemetry: DesktopUpdateLifecycleReporter;
};

/** Whether the packaged updater must skip download/staging, and why. */
type PackagedUpdateFeedState = {
  updateInstallBlocked: boolean;
  fakeFeedActive: boolean;
};

/**
 * Install the app's update lane now and return the function that starts its
 * checks: the packaged electron-updater flow when the packaged path is active,
 * otherwise the dev-mode git-based update nudge, unless the launch turned it off
 * (`DEV_UPDATE_CHECK_DISABLED_ENV`). Both arms arm a recurring
 * `UPDATE_CHECK_INTERVAL_MS` poll, replacing any prior timer.
 *
 * Two steps because a check can precede the boot check (ISS-10291): the
 * renderer's check IPC is live from the `DesktopApplication` constructor, and
 * electron-updater emits `update-available` / `update-downloaded` once, to
 * whoever is listening. Installing the state machine before anything can check
 * leaves no event for it to miss; when the checks start is unchanged.
 */
export function installDesktopUpdateLane(
  deps: DesktopUpdateWiringDeps
): () => void {
  if (isPackagedUpdateFlowActive(app.isPackaged)) {
    registerPackagedUpdaterEvents(deps, configurePackagedUpdateFeed());
    return () => {
      checkForPackagedUpdatesNow(deps);
      schedulePackagedUpdatePolling(deps);
    };
  }
  if (isDevUpdateCheckDisabled()) {
    return () => undefined;
  }
  return () => {
    checkForDevUpdateNow(deps);
    scheduleDevUpdatePolling(deps);
  };
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
  deps: DesktopUpdateWiringDeps,
  backgroundFailures: BackgroundCheckFailureStreak
): void {
  autoUpdater.on("error", (err, updaterDetail) => {
    const heldBack = holdBackBackgroundCheckFailure(
      deps,
      backgroundFailures,
      err.message,
      updaterDetail
    );
    const level = heldBack || isNetworkError(err.message) ? "debug" : "error";
    gatewayLog[level]("auto-update", `Auto-update error: ${err.message}`);
    if (
      heldBack ||
      isCheckFailureOverInFlightUpdate(
        deps.getPackagedUpdateState(),
        updaterDetail
      )
    ) {
      deps.updateTelemetry.checkFailed(err.message);
      return;
    }
    if (isReadOnlyVolumeUpdateError(err.message)) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      // Same permanently-stuck install as the startup translocation check, just
      // discovered from the Squirrel error instead. It reported nothing before.
      deps.updateTelemetry.installBlocked(
        deps.getPackagedUpdateState().version
      );
      deps.handleUpdateInstallBlocked(deps.getPackagedUpdateState().version);
      return;
    }
    let alreadyReported = false;
    if (
      isUpdateCheckPhaseError(updaterDetail) &&
      foregroundChecksInFlight > 0
    ) {
      alreadyReported = backgroundFailures.reported();
    }
    const priorState = deps.getPackagedUpdateState();
    deps.setPackagedUpdateState({
      status: "error",
      available: false,
      downloaded: false,
      error: err.message,
      percent: undefined,
    });
    deps.notifyPackagedUpdateStatus();
    reportUpdaterError(deps, priorState, err.message, updaterDetail);
    if (alreadyReported) {
      return;
    }
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

/**
 * Route one updater error to the right event, using the version read BEFORE the
 * caller's error patch clears it so a download failure names its release.
 */
function reportUpdaterError(
  deps: DesktopUpdateWiringDeps,
  priorState: PackagedUpdateState,
  message: string,
  updaterDetail: string | undefined
): void {
  if (isUpdateDownloadPhaseError(priorState, app.getVersion(), updaterDetail)) {
    deps.updateTelemetry.downloadFailed(priorState.version, message);
    return;
  }
  deps.updateTelemetry.checkFailed(message);
}

/** The available → downloading → downloaded → not-available state machine. */
function registerPackagedUpdaterEvents(
  deps: DesktopUpdateWiringDeps,
  feedState: PackagedUpdateFeedState
): void {
  const backgroundFailures = createBackgroundCheckFailureStreak();
  registerPackagedUpdaterErrorHandler(deps, backgroundFailures);
  // FIRST, so an early return in the state-machine handler below cannot skip it.
  registerUpdaterDownloadHeaderNarrowing();
  autoUpdater.on("update-available", (info) => {
    // ISS-7225's lag pair lives on the `check` record, so it must be emitted on
    // the offered path too — otherwise the lag measure would only ever describe
    // installations that are already up to date.
    deps.updateTelemetry.checked(info.version);
    deps.updateTelemetry.available(info.version);
    if (feedState.updateInstallBlocked && !feedState.fakeFeedActive) {
      // FEA-2349: no download will follow (autoDownload is off), so a
      // "downloading" banner would mislead. Surface the actionable
      // error state and tell the user how to self-resolve.
      deps.updateTelemetry.installBlocked(info.version);
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
    // autoDownload is off under both guards above, so this reports a download
    // beginning only where one really does.
    if (autoUpdater.autoDownload) {
      deps.updateTelemetry.downloadStarted(info.version);
    }
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
    deps.updateTelemetry.downloadSucceeded(info.version);
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
    // No target: the ABSENCE of `update.to_version` is what says "up to date".
    // `info.version` here is the installed build, not an offer.
    deps.updateTelemetry.checked();
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
  // Last: a throw in the handlers above stops the emit before these run, and
  // electron-updater then reports that check as failed (AppUpdater.js:271).
  autoUpdater.on("update-available", backgroundFailures.reset);
  autoUpdater.on("update-not-available", backgroundFailures.reset);
}

/**
 * The boot-time packaged check. A failure is a first-class error state (the
 * banner shows it), never an unhandled rejection. Its telemetry is the `error`
 * listener's: electron-updater emits `error` before it rejects
 * (AppUpdater.js:271), so reporting here too counted one failure twice.
 */
function checkForPackagedUpdatesNow(deps: DesktopUpdateWiringDeps): void {
  checkForStampedUpdates(deps.getComputeTargetId)
    .then((result) => deps.guardUpdateDownload(result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      gatewayLog.error("auto-update", `Failed to check for updates: ${msg}`);
      if (isUpdateInFlight(deps.getPackagedUpdateState())) {
        return;
      }
      deps.setPackagedUpdateState({
        status: "error",
        available: false,
        downloaded: false,
        error: msg,
        percent: undefined,
      });
      deps.notifyPackagedUpdateStatus();
    });
}

/**
 * Recurring packaged poll, the one background check. Its transient network
 * failure is debug-only until background checks have failed for
 * `PERSISTENT_BACKGROUND_CHECK_FAILURE_MS` (ISS-11645); any other failure surfaces
 * at once. The `error` listener owns that threshold and the banner.
 */
function schedulePackagedUpdatePolling(deps: DesktopUpdateWiringDeps): void {
  clearExistingUpdateCheckTimer(deps);
  deps.setUpdateCheckTimer(
    setInterval(() => {
      checkForStampedUpdates(deps.getComputeTargetId, { background: true })
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

/**
 * Stamp this install's ring identity on the updater's request, then check.
 *
 * Exported because it is the seam EVERY `autoUpdater.checkForUpdates()` in this
 * app goes through — the boot check and recurring poll below, the gateway
 * update action (`app.ts`), and the renderer's update IPC
 * (`desktop-ipc-registration.ts`). Those last two called the singleton directly
 * until #6867, and `requestHeaders` is a sticky property on it, so they did not
 * send nothing — they sent whatever the last SCHEDULED check left behind. At
 * boot that is version-only, because the compute target is hello-derived and
 * null for the first seconds of a launch, so a user who launched and hit "Check
 * for updates" straight away landed on the general ring: exactly what someone
 * in the internal ring does when they hear there is a new build (marisolashgrove,
 * #6867). Take the accessor rather than the wiring deps so a caller that owns
 * no update lane can still route through here.
 *
 * Only the recurring poll passes `background`. Every other check (boot, the
 * renderer's, the gateway's) surfaces its failure at once (ISS-11645).
 *
 * Stamped before EVERY check rather than once at wiring time (PRD-707 O1):
 * the boot check starts synchronously during boot, while the
 * compute target is hello-derived and null until the relay socket has been up
 * once. A one-shot read at wiring time would therefore resolve null on every
 * launch and leave every install permanently unringed.
 *
 * KNOW WHERE THESE HEADERS GO. `requestHeaders` is one property shared by the
 * feed check and the asset DOWNLOAD (`AppUpdater.computeRequestHeaders`), and the
 * asset route answers with a cross-origin 302 to the release host. So whatever is
 * still on this property when a download starts reaches that third-party host:
 * `builder-util-runtime@9.6.2` — the version `electron-updater@6.8.7` pins
 * exactly — strips ONE header on a cross-origin redirect, `authorization`
 * (`prepareRedirectUrlOptions`), and has no extensible sensitive-header set.
 * `addSensitiveRedirectHeader` exists only in 9.7.0, which the updater does not
 * resolve, so there is no upstream seam to wire here.
 *
 * Anything added here is therefore classified before it can be sent:
 * `DesktopUpdaterRequestFields` in the builder's own module gives every field a
 * `redirectSafety`, a new field does not compile without one, and
 * `registerUpdaterDownloadHeaderNarrowing` drops everything not classified
 * `AnyOrigin` before a download reads this property (ISS-9790). A header added
 * here cannot reach `objects.githubusercontent.com` by omission — only by
 * someone answering that question with `AnyOrigin`.
 *
 * THE NARROWING IS INSTALLED HERE, one line above the stamp, and that adjacency
 * is the fix for ISS-10127 rather than a tidiness. It used to be installed only
 * by the boot-time update wiring, which boot reached long after the constructor
 * wires the renderer's check-for-updates IPC and after the window that can send
 * it exists — so a check arriving in between found no listener, and
 * `autoDownload` defaults to true, so it went straight to a download carrying
 * the id. Nothing announced that: the download succeeds either way. Stamping and
 * protecting are now one call apart in one function, so re-opening the window
 * takes deleting a line from the body that does the stamping rather than
 * reordering two distant boot steps.
 */
export function checkForStampedUpdates(
  getComputeTargetId: () => string | null,
  { background = false }: { background?: boolean } = {}
): ReturnType<typeof autoUpdater.checkForUpdates> {
  registerUpdaterDownloadHeaderNarrowing();
  autoUpdater.requestHeaders = buildDesktopUpdaterRequestHeaders({
    computeTargetId: resolveComputeTargetIdForUpdater(getComputeTargetId),
    clientVersion: app.getVersion(),
  });
  if (background) {
    return autoUpdater.checkForUpdates();
  }
  foregroundChecksInFlight += 1;
  return autoUpdater.checkForUpdates().finally(() => {
    foregroundChecksInFlight -= 1;
  });
}

/**
 * The compute target, or null if resolving it throws.
 *
 * RESOLVING, not reading (marisolashgrove, #6867). The supplier this is wired to —
 * `SessionSyncIdentityAdapter.authenticatedComputeTargetId` — reaches
 * `RetainedComputeTargetIdentity.resolve`, which adopts an unattributed live id
 * into the retained record, so a check can be the call that performs that write.
 * It is the same write the sync lane's own resolve performs, off the same live
 * sources and therefore with the same value; what this adds is a second clock
 * that can reach it first. Named for what it does so the next reader does not
 * take it for a guarded read.
 *
 * A telemetry-shaped header must never be the reason the update lane fails, and
 * this one is resolved on a synchronous path inside the lane's boot check —
 * whose only caller wraps it in the boot try/catch that aborts startup. A
 * resolver that throws during a disposed-host shutdown would take the window
 * with it.
 */
function resolveComputeTargetIdForUpdater(
  getComputeTargetId: () => string | null
): string | null {
  try {
    return getComputeTargetId();
  } catch {
    return null;
  }
}

/**
 * Narrow the shared `requestHeaders` to the redirect-safe set before any
 * download can read them (davetho, #6867; generalised by ISS-9790).
 *
 * `requestHeaders` is one property (`AppUpdater.computeFinalHeaders`) read by the
 * feed check AND, separately, by `computeRequestHeaders` when a download starts —
 * and nothing downstream strips it: see `checkForStampedUpdates` above for why
 * the pinned `builder-util-runtime` carries no seam for that. Left alone, an
 * opaque per-install id would reach `objects.githubusercontent.com` on every real
 * update download.
 *
 * `update-available` IS a sound seam, and the ordering is the whole reason:
 * `doCheckForUpdates` calls `onUpdateAvailable` (`AppUpdater.js:414`), whose
 * `emit` (`:429`) runs every listener SYNCHRONOUSLY, and only then evaluates
 * `downloadUpdate()` (`:422`), which recomputes the download's headers from this
 * property (`:463`). Raw line numbers read the other way round, which is how the
 * first pass at #6867 concluded no seam existed; execution order is what governs.
 * Every download in this app is started by `autoDownload` on that path — nothing
 * here calls `autoUpdater.downloadUpdate()` — and the manual `downloadUpdate()`
 * entry point also reads this property live, after its own `update-available`.
 *
 * NARROWING THE LIVE PROPERTY, not rebuilding a known-good pair. #6867 restamped
 * `{clientVersion}` here, which is correct only while everyone who adds a header
 * remembers to come back and retype it; `narrowDesktopUpdaterHeadersForRedirect`
 * instead keeps exactly what the contract classified `AnyOrigin` and drops
 * everything else, including a header this file never built. That is the
 * fail-closed half of ISS-9790 — the compile-time half is the exhaustive
 * `Record` the classification lives in.
 *
 * `x-desktop-client-version` STAYS, and that is a classification, not an
 * omission: the asset URL already spells the version
 * (`…/desktop-v<ver>/Closedloop-<ver>-universal-mac.zip`), so it tells the release
 * host nothing the request did not already carry; the compute-target id does.
 *
 * The next check re-stamps the full set, so this narrows the download without
 * un-ringing the feed.
 *
 * CALLED FROM TWO PLACES AND IDEMPOTENT (ISS-10127). `installDesktopUpdateLane`
 * still calls it first so the listener order is unchanged. Every stamping check
 * calls it too: the constructor installs the lane before any check can run
 * (ISS-10291), so today that call returns early, and it keeps a check's download
 * narrowed if the install ever moves behind a check again. `on` appends per call
 * and `autoUpdater` lives for the whole process, so a poll on
 * `UPDATE_CHECK_INTERVAL_MS` would accumulate twelve listeners an hour — hence a
 * single named handler and a question put to the EMITTER, whose listener list is
 * the one signal that stays true when something else calls `removeAllListeners`.
 */
function registerUpdaterDownloadHeaderNarrowing(): void {
  if (
    autoUpdater
      .listeners("update-available")
      .includes(narrowUpdaterHeadersForDownload)
  ) {
    return;
  }
  autoUpdater.on("update-available", narrowUpdaterHeadersForDownload);
}

/** The single listener instance the installer above checks the emitter for. */
function narrowUpdaterHeadersForDownload(): void {
  autoUpdater.requestHeaders = narrowDesktopUpdaterHeadersForRedirect(
    autoUpdater.requestHeaders
  );
}

/**
 * Chromium codes held back as ISS-11645 AC1's "transient network error" that
 * `isNetworkError` does not match. The hold adds them rather than widening that
 * shared log-level matcher. `ERR_TIMED_OUT` and `ERR_NETWORK_IO_SUSPENDED` are
 * ISS-11645's; `ERR_NETWORK_CHANGED` is ISS-12174's. The `ERR_CONNECTION_*`
 * three are what Chromium maps `ECONNRESET`, `ECONNREFUSED` and a connect's
 * `ETIMEDOUT` to (`MapSystemError`, `MapConnectError`), and `isNetworkError`
 * already holds those Node spellings back (ISS-12174 AC1).
 */
const HELD_BACK_NETWORK_ERROR_RE =
  /ERR_TIMED_OUT|ERR_NETWORK_IO_SUSPENDED|ERR_NETWORK_CHANGED|ERR_CONNECTION_(?:RESET|REFUSED|TIMED_OUT)/;

/**
 * Whether a failed check is a background one this run holds back from the banner
 * and `electron_update.failed` (ISS-11645): no caller is waiting, it is a
 * transient network error, no update is in flight, it is not a read-only-volume
 * block, and the run has not yet persisted. Network errors only: Perrin,
 * 2026-09-30, ISS-11645. A feed or signature error surfaces at once.
 * Records the failure in the run, so call it once per `error` event.
 */
function holdBackBackgroundCheckFailure(
  deps: DesktopUpdateWiringDeps,
  backgroundFailures: BackgroundCheckFailureStreak,
  message: string,
  updaterDetail: string | undefined
): boolean {
  return (
    isUpdateCheckPhaseError(updaterDetail) &&
    foregroundChecksInFlight === 0 &&
    (isNetworkError(message) || HELD_BACK_NETWORK_ERROR_RE.test(message)) &&
    !isUpdateInFlight(deps.getPackagedUpdateState()) &&
    !isReadOnlyVolumeUpdateError(message) &&
    !backgroundFailures.fail(Date.now())
  );
}
