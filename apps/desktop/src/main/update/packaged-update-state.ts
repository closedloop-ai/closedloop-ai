import type { PackagedUpdateInstallBlockedReason } from "../../shared/packaged-update-install-blocked-reason.js";

export type PackagedUpdateStatus =
  | "idle"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export type PackagedUpdateState = {
  status: PackagedUpdateStatus;
  available: boolean;
  downloaded: boolean;
  version?: string;
  percent?: number;
  error?: string;
  installBlockedReason?: PackagedUpdateInstallBlockedReason;
};

export type PackagedUpdateStatusPayload = {
  status: PackagedUpdateStatus;
  updateAvailable: boolean;
  readyToInstall: boolean;
  version?: string;
  percent?: number;
  error?: string;
  installBlockedReason?: PackagedUpdateInstallBlockedReason;
};

export const PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE =
  "Update has not finished downloading yet";

/** Statuses proving an update was already OFFERED when an error landed. */
const UPDATE_IN_FLIGHT_STATUSES: ReadonlySet<PackagedUpdateStatus> =
  new Set<PackagedUpdateStatus>(["available", "downloading", "downloaded"]);

/**
 * ISS-7247: whether an error on electron-updater's single `error` channel is a
 * download failure rather than a check failure.
 *
 * The `error` case is the SECOND error of the same download: the first already
 * patched the status. `update-not-available` also records a version — the
 * installed build — so the comparison, not mere presence, discriminates.
 *
 * The updater's own check-failure detail outranks the state (ISS-11447): a
 * poll that fails after a download finished is a check failure, not a second
 * failure of that download.
 *
 * Here rather than beside its caller so it stays testable: the wiring module
 * imports `electron` at load, which a unit test cannot.
 */
export function isUpdateDownloadPhaseError(
  priorState: PackagedUpdateState,
  currentVersion: string,
  updaterDetail?: string
): boolean {
  if (isUpdateCheckPhaseError(updaterDetail)) {
    return false;
  }
  if (isUpdateInFlight(priorState)) {
    return true;
  }
  return (
    priorState.status === "error" &&
    priorState.version !== undefined &&
    priorState.version !== currentVersion
  );
}

/** Returns the initial packaged updater state before electron-updater emits. */
export function createInitialPackagedUpdateState(): PackagedUpdateState {
  return {
    status: "idle",
    available: false,
    downloaded: false,
  };
}

/** Applies a partial electron-updater transition without losing prior version. */
export function mergePackagedUpdateState(
  current: PackagedUpdateState,
  patch: Partial<PackagedUpdateState>
): PackagedUpdateState {
  return {
    ...current,
    ...patch,
    installBlockedReason:
      "installBlockedReason" in patch ? patch.installBlockedReason : undefined,
  };
}

/** Builds the renderer-facing update readiness payload. */
export function toPackagedUpdateStatusPayload(
  state: PackagedUpdateState
): PackagedUpdateStatusPayload {
  return {
    status: state.status,
    updateAvailable: state.available,
    readyToInstall: state.downloaded,
    ...(state.version !== undefined && { version: state.version }),
    ...(state.percent !== undefined && { percent: state.percent }),
    ...(state.error !== undefined && { error: state.error }),
    ...(state.installBlockedReason !== undefined && {
      installBlockedReason: state.installBlockedReason,
    }),
  };
}

/** Enforces the defensive IPC invariant even if the renderer state is stale. */
export function assertPackagedUpdateReadyToInstall(
  state: PackagedUpdateState
): void {
  if (!state.downloaded) {
    throw new Error(PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE);
  }
}

/**
 * The detail electron-updater 6.8.7 passes as the `error` event's second
 * argument when a CHECK fails (`AppUpdater.checkForUpdates`, out/AppUpdater.js
 * line 271). A failed download goes through `dispatchError`, which passes the
 * stack instead, so this prefix is what tells the two apart on the one channel.
 */
const UPDATE_CHECK_FAILURE_DETAIL_PREFIX = "Cannot check for updates";

/** Whether an updater `error` event came from a failed check. */
export function isUpdateCheckPhaseError(updaterDetail?: string): boolean {
  return updaterDetail?.startsWith(UPDATE_CHECK_FAILURE_DETAIL_PREFIX) === true;
}

/**
 * ISS-11447: a failed check does not touch an update already offered,
 * downloading or downloaded. electron-updater's download runs on its own
 * promise, and MacUpdater keeps a staged update installable
 * (`squirrelDownloadedUpdate`) across later failed checks, so an error patch
 * here would withdraw a restart the updater can still perform.
 */
export function isCheckFailureOverInFlightUpdate(
  priorState: PackagedUpdateState,
  updaterDetail?: string
): boolean {
  return isUpdateCheckPhaseError(updaterDetail) && isUpdateInFlight(priorState);
}

/**
 * Whether an update is offered, downloading or downloaded. A caller whose own
 * check just failed leaves such a state alone (ISS-11447): the `error` listener
 * has already reported that failure as `check_failed`.
 */
export function isUpdateInFlight(state: PackagedUpdateState): boolean {
  return UPDATE_IN_FLIGHT_STATUSES.has(state.status);
}

/**
 * How long background update checks must keep failing with a transient network
 * error before the failure shows the banner and counts as
 * `electron_update.failed` (ISS-11645). Perrin's ruling
 * on ISS-11447 AC1, 2026-09-30: "No, only if persistent"; 24 h is the example
 * threshold of the option he picked.
 */
export const PERSISTENT_BACKGROUND_CHECK_FAILURE_MS = 24 * 60 * 60 * 1000;

/** The run of network-failed background checks since the last successful check. */
export function createBackgroundCheckFailureStreak() {
  let failingSince: number | null = null;
  let surfaced = false;
  let surfacedByBackground = false;
  return {
    /** Record a failed background check; true only for the one that makes the run persistent. */
    fail(now: number): boolean {
      failingSince ??= now;
      if (
        surfaced ||
        now - failingSince < PERSISTENT_BACKGROUND_CHECK_FAILURE_MS
      ) {
        return false;
      }
      surfaced = true;
      surfacedByBackground = true;
      return true;
    },
    /**
     * A failed check that surfaced at once: the run it opens or joins is already
     * reported. True when a background check already reported this run, so this
     * failure's `electron_update.failed` would be the run's second.
     */
    reported(): boolean {
      surfaced = true;
      return surfacedByBackground;
    },
    reset(): void {
      failingSince = null;
      surfaced = false;
      surfacedByBackground = false;
    },
  };
}

export type BackgroundCheckFailureStreak = ReturnType<
  typeof createBackgroundCheckFailureStreak
>;
