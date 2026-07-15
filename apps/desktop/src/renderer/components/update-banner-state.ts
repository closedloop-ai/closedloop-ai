import {
  PACKAGED_UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE,
  PackagedUpdateInstallBlockedReason,
  type PackagedUpdateInstallBlockedReason as PackagedUpdateInstallBlockedReasonValue,
} from "../../shared/packaged-update-install-blocked-reason";

/**
 * Renderer-side model of the desktop auto-update banner.
 *
 * Mirrors the main-process PackagedUpdateStatusPayload
 * (src/main/packaged-update-state.ts) but is kept local so the renderer stays
 * decoupled from main-process modules. The pure reducers/selectors here are the
 * single source of truth for banner visibility and the apply gate, so they can
 * be unit-tested without a DOM (see test/update-banner-state.test.ts).
 *
 * Two IPC-bridged window events feed this state:
 *  - `desktop:update-status`    -> the canonical PackagedUpdateStatusPayload
 *  - `desktop:update-available` -> a lighter nudge ({ updateAvailable, version,
 *                                   readyToInstall } when packaged; the
 *                                   checkForUpdate() result in dev) with no
 *                                   `status` field.
 */
export type UpdateBannerStatus =
  | "idle"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export type UpdateBannerState = {
  status: UpdateBannerStatus;
  updateAvailable: boolean;
  readyToInstall: boolean;
  version?: string;
  percent?: number;
  error?: string;
  installBlockedReason?: PackagedUpdateInstallBlockedReasonValue;
};

export const UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE =
  PACKAGED_UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE;

export const INITIAL_UPDATE_BANNER_STATE: UpdateBannerState = {
  status: "idle",
  updateAvailable: false,
  readyToInstall: false,
};

const KNOWN_STATUSES: readonly UpdateBannerStatus[] = [
  "idle",
  "available",
  "downloading",
  "downloaded",
  "not-available",
  "error",
];

function asRecord(detail: unknown): Record<string, unknown> | null {
  return typeof detail === "object" && detail !== null
    ? (detail as Record<string, unknown>)
    : null;
}

function asStatus(value: unknown): UpdateBannerStatus | null {
  return typeof value === "string" &&
    (KNOWN_STATUSES as readonly string[]).includes(value)
    ? (value as UpdateBannerStatus)
    : null;
}

function asInstallBlockedReason(
  value: unknown
): PackagedUpdateInstallBlockedReasonValue | undefined {
  return value === PackagedUpdateInstallBlockedReason.ReadOnlyVolume
    ? value
    : undefined;
}

/**
 * Applies a `desktop:update-status` event (the canonical
 * PackagedUpdateStatusPayload) over the previous banner state. Payloads without
 * a recognized `status` field are ignored (untrusted IPC boundary).
 */
export function reduceUpdateStatusEvent(
  prev: UpdateBannerState,
  detail: unknown
): UpdateBannerState {
  const record = asRecord(detail);
  const status = record ? asStatus(record.status) : null;
  if (!(record && status)) {
    return prev;
  }
  return {
    status,
    updateAvailable: record.updateAvailable === true,
    readyToInstall: record.readyToInstall === true,
    version: typeof record.version === "string" ? record.version : undefined,
    percent: typeof record.percent === "number" ? record.percent : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    installBlockedReason: asInstallBlockedReason(record.installBlockedReason),
  };
}

/**
 * Applies a `desktop:update-available` nudge. This event carries no `status`
 * field, so we only escalate to "available" and never regress a more advanced
 * downloading/downloaded state observed via `desktop:update-status`.
 */
export function reduceUpdateAvailableEvent(
  prev: UpdateBannerState,
  detail: unknown
): UpdateBannerState {
  const record = asRecord(detail);
  if (record?.updateAvailable !== true) {
    return prev;
  }
  const version =
    typeof record.version === "string" ? record.version : prev.version;
  if (isUpdateInstallBlocked(prev)) {
    return { ...prev, updateAvailable: true, version };
  }
  if (prev.status === "downloading" || prev.status === "downloaded") {
    return { ...prev, updateAvailable: true, version };
  }
  return {
    ...prev,
    status: "available",
    updateAvailable: true,
    readyToInstall: false,
    version,
  };
}

/** The banner is only shown for actionable/visible update states. */
export function isUpdateBannerVisible(state: UpdateBannerState): boolean {
  if (state.status === "error") {
    return true;
  }
  if (state.status === "idle" || state.status === "not-available") {
    return false;
  }
  return state.updateAvailable || state.readyToInstall;
}

/** True when installation is blocked until macOS moves the app bundle. */
export function isUpdateInstallBlocked(state: UpdateBannerState): boolean {
  return (
    state.status === "error" &&
    state.installBlockedReason ===
      PackagedUpdateInstallBlockedReason.ReadOnlyVolume
  );
}

/**
 * The Apply / Restart action is only enabled once the update is fully
 * downloaded. This mirrors the main-process invariant
 * (assertPackagedUpdateReadyToInstall) so the renderer never offers an apply
 * action the main process would reject.
 */
export function isUpdateApplyEnabled(state: UpdateBannerState): boolean {
  return (
    !isUpdateInstallBlocked(state) &&
    state.status === "downloaded" &&
    state.readyToInstall === true
  );
}

/** Human-readable banner message for the current state. */
export function updateBannerMessage(state: UpdateBannerState): string {
  if (isUpdateInstallBlocked(state)) {
    return UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE;
  }

  switch (state.status) {
    case "downloaded":
      return state.version
        ? `Version ${state.version} is ready to install.`
        : "A new version is ready to install.";
    case "downloading": {
      const pct =
        typeof state.percent === "number"
          ? ` (${Math.round(state.percent)}%)`
          : "";
      const ver = state.version ? ` ${state.version}` : "";
      return `Downloading update${ver}${pct}...`;
    }
    case "available":
      return state.version
        ? `Version ${state.version} is available and downloading.`
        : "A new version is available.";
    case "error":
      return state.error
        ? `Update error: ${state.error}`
        : "Update failed. It will retry automatically.";
    default:
      return "";
  }
}
