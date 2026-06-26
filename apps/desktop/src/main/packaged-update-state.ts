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
};

export type PackagedUpdateStatusPayload = {
  status: PackagedUpdateStatus;
  updateAvailable: boolean;
  readyToInstall: boolean;
  version?: string;
  percent?: number;
  error?: string;
};

export const PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE =
  "Update has not finished downloading yet";

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
