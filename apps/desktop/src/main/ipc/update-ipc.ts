import { app } from "electron";
import type pkg from "electron-updater";
import { UpdateIpcChannel } from "../../shared/update-ipc-channel.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { Observability } from "../telemetry/observability.js";
import { isPackagedUpdateFlowActive } from "../update/fake-update-feed.js";
import {
  assertPackagedUpdateReadyToInstall,
  isUpdateInFlight,
  PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE,
  type PackagedUpdateState,
  type PackagedUpdateStatusPayload,
} from "../update/packaged-update-state.js";
import type { DesktopUpdateLifecycleReporter } from "../update/update-lifecycle-telemetry.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

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
  /**
   * The packaged feed probe. Injected rather than reached for at module scope:
   * `electron-updater` is CJS inside `node_modules`, so a module-scoped
   * value import of it survives no module mock, and its macOS `MacUpdater` does
   * `require("electron").autoUpdater.on("error")` at construction. That is what
   * left this module unloadable outside a real Electron process, and therefore
   * its IPC contract untested (ISS-4514).
   */
  checkForUpdates: () => ReturnType<typeof pkg.autoUpdater.checkForUpdates>;
  guardUpdateDownload: (
    result: Awaited<ReturnType<typeof pkg.autoUpdater.checkForUpdates>>
  ) => void;
  checkForUpdate: () => Promise<UnpackagedUpdateCheckResult>;
  notifyPackagedUpdateStatus: () => void;
  setApplyingDownloadedUpdate: (value: boolean) => void;
  applyUpdate: () => Promise<void>;
  /** ISS-7247 release-health reporter; see `DesktopUpdateWiringDeps`. */
  updateTelemetry: DesktopUpdateLifecycleReporter;
};

/**
 * Packaged (auto-updater) manual check: probe the feed and report the state its
 * events recorded. electron-updater emits `update-available` or
 * `update-not-available` before `checkForUpdates()` resolves, and the lane's
 * state machine is installed before this handler is registered (ISS-10291), so
 * the state machine is the only writer.
 */
async function runPackagedUpdateCheck(
  deps: UpdateIpcDeps
): Promise<PackagedUpdateStatusPayload> {
  deps.guardUpdateDownload(await deps.checkForUpdates());
  return deps.getPackagedUpdateStatusPayload();
}

/**
 * Surface a check failure: packaged builds record the error state, unless an
 * update is already in flight (ISS-11447, see `isUpdateInFlight`); else report it.
 * A packaged failure's telemetry is the updater `error` listener's, which
 * electron-updater fires before it rejects (AppUpdater.js:271).
 */
function handleUpdateCheckError(
  deps: UpdateIpcDeps,
  error: unknown
): PackagedUpdateStatusPayload | { updateAvailable: false; error: string } {
  const message = error instanceof Error ? error.message : "unknown error";
  if (app.isPackaged) {
    if (isUpdateInFlight(deps.getPackagedUpdateState())) {
      return deps.getPackagedUpdateStatusPayload();
    }
    deps.setPackagedUpdateState({
      status: "error",
      available: false,
      downloaded: false,
      error: message,
    });
    deps.notifyPackagedUpdateStatus();
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
  deps.updateTelemetry.installStarted(state.version);
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
      // True for packaged builds and for the FEA-2099 fake-feed e2e seam, so a
      // launched-app spec can drive a real renderer check (ISS-10291).
      if (isPackagedUpdateFlowActive(app.isPackaged)) {
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
