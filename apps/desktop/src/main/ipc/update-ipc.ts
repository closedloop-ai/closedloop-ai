import { app } from "electron";
import pkg from "electron-updater";
import { gatewayLog } from "../logging/gateway-logger.js";
import { Observability } from "../telemetry/observability.js";
import {
  isFakeUpdateFeedActive,
  isPackagedUpdateFlowActive,
} from "../update/fake-update-feed.js";
import {
  assertPackagedUpdateReadyToInstall,
  PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE,
  type PackagedUpdateState,
  type PackagedUpdateStatusPayload,
} from "../update/packaged-update-state.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

const { autoUpdater } = pkg;

export const UpdateIpcChannel = {
  CheckForUpdate: "desktop:check-for-update",
  ApplyUpdate: "desktop:apply-update",
} as const;

export type UpdateIpcChannel =
  (typeof UpdateIpcChannel)[keyof typeof UpdateIpcChannel];

/** The `desktop:check-for-update` result for the unpackaged (git) update path. */
type UnpackagedUpdateCheckResult = {
  updateAvailable: boolean;
  currentHash: string;
  remoteHash: string;
};

type IpcMainLike = {
  handle: (
    channel: UpdateIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type UpdateIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  getPackagedUpdateState: () => PackagedUpdateState;
  setPackagedUpdateState: (patch: Partial<PackagedUpdateState>) => void;
  getPackagedUpdateStatusPayload: () => PackagedUpdateStatusPayload;
  guardUpdateDownload: (
    result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
  ) => void;
  checkForUpdate: () => Promise<UnpackagedUpdateCheckResult>;
  notifyPackagedUpdateStatus: () => void;
  setApplyingDownloadedUpdate: (value: boolean) => void;
  applyUpdate: () => Promise<void>;
};

/** Packaged (auto-updater) manual check: probe the feed and promote to available. */
async function runPackagedUpdateCheck(
  deps: UpdateIpcDeps
): Promise<PackagedUpdateStatusPayload> {
  const result = await autoUpdater.checkForUpdates();
  deps.guardUpdateDownload(result);
  const remoteVersion = result?.updateInfo?.version;
  if (
    remoteVersion != null &&
    remoteVersion !== app.getVersion() &&
    deps.getPackagedUpdateState().status === "idle"
  ) {
    deps.setPackagedUpdateState({
      status: "available",
      available: true,
      downloaded: false,
      version: remoteVersion,
    });
  }
  return deps.getPackagedUpdateStatusPayload();
}

/** Surface a check failure: packaged builds record the error state; else report it. */
function handleUpdateCheckError(
  deps: UpdateIpcDeps,
  error: unknown
): PackagedUpdateStatusPayload | { updateAvailable: false; error: string } {
  const message = error instanceof Error ? error.message : "unknown error";
  if (app.isPackaged) {
    deps.setPackagedUpdateState({
      status: "error",
      available: false,
      downloaded: false,
      error: message,
    });
    deps.notifyPackagedUpdateStatus();
    const state = deps.getPackagedUpdateState();
    Observability.electronUpdateFailed({
      trigger: "manual-check",
      status: state.status,
      version: state.version,
      error: message,
      downloaded: state.downloaded,
      readyToInstall: state.downloaded,
    });
    return deps.getPackagedUpdateStatusPayload();
  }
  return {
    updateAvailable: false,
    error: message,
  };
}

/**
 * Packaged apply: verify the update is downloaded, then request a graceful quit
 * (the before-quit handler runs shutdown cleanup, then finishUpdateInstall does
 * the install + relaunch — see FEA-2026). Throws if not ready to install.
 */
function applyPackagedUpdate(deps: UpdateIpcDeps): void {
  const state = deps.getPackagedUpdateState();
  gatewayLog.info(
    "auto-update",
    `apply-update IPC invoked status=${state.status} downloaded=${state.downloaded}`
  );
  try {
    assertPackagedUpdateReadyToInstall(state);
  } catch {
    const message = PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE;
    gatewayLog.warn("auto-update", message);
    Observability.electronUpdateFailed({
      trigger: "apply-before-downloaded",
      status: state.status,
      version: state.version,
      error: message,
      downloaded: state.downloaded,
      readyToInstall: false,
    });
    throw new Error(message);
  }

  deps.setApplyingDownloadedUpdate(true);
  Observability.electronUpdateInitiated({
    trigger: "renderer-apply-update",
    status: state.status,
    version: state.version,
    downloaded: true,
    readyToInstall: true,
  });
  // Trigger a normal quit rather than calling quitAndInstall() inline. The
  // before-quit handler runs graceful shutdown cleanup first and then hands the
  // install + relaunch to the updater via finishUpdateInstall(). Calling
  // quitAndInstall() here while the before-quit handler force-exits the process
  // was what left the renderer stuck on "Restarting…" (FEA-2026).
  gatewayLog.info(
    "auto-update",
    "apply-update: requesting graceful quit before updater install"
  );
  app.quit();
}

export function registerUpdateIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: UpdateIpcDeps
): void {
  ipcMainLike.handle(UpdateIpcChannel.CheckForUpdate, async (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    try {
      // FEA-2099 fake-feed e2e: boot already ran the real check and promoted
      // packagedUpdateState to downloaded; just surface that status payload so
      // the test can observe readyToInstall without re-fetching the fixture.
      if (isFakeUpdateFeedActive(app.isPackaged)) {
        return deps.getPackagedUpdateStatusPayload();
      }
      if (app.isPackaged) {
        return await runPackagedUpdateCheck(deps);
      }
      return await deps.checkForUpdate();
    } catch (error) {
      return handleUpdateCheckError(deps, error);
    }
  });
  ipcMainLike.handle(UpdateIpcChannel.ApplyUpdate, async (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    // isPackagedUpdateFlowActive() is true for packaged builds and for the
    // FEA-2099 fake-feed e2e seam, so the e2e can drive the real
    // apply → quit → before-quit → finishUpdateInstall handoff (FEA-2026).
    if (isPackagedUpdateFlowActive(app.isPackaged)) {
      applyPackagedUpdate(deps);
      return;
    }
    await deps.applyUpdate();
  });
}
