import { PackagedUpdateInstallBlockedReason } from "../../shared/packaged-update-install-blocked-reason.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { DesktopUpdateDiagnostics } from "../telemetry/telemetry-protocol.js";
import type { PackagedUpdateState } from "./packaged-update-state.js";
import {
  formatUpdateBlockedBannerMessage,
  formatUpdateBlockedDialogBody,
  formatUpdateBlockedManualStepsBody,
  UPDATE_BLOCKED_DIALOG_TITLE,
  UPDATE_BLOCKED_LATER_BUTTON,
  UPDATE_BLOCKED_MOVE_BUTTON,
} from "./update-install-blocked.js";

/**
 * Telemetry surface the controller emits to when an install is blocked. Matches
 * `Observability.electronUpdateFailed` so the host can pass it directly.
 */
export type UpdateBlockedTelemetry = {
  updateFailed: (input: DesktopUpdateDiagnostics) => void;
};

/**
 * The narrow Electron surface the blocked-flow drives. Injected (rather than
 * imported from `electron` here) so the controller loads and unit-tests in a
 * plain Node process — the host wires these from `dialog`/`app`.
 */
export type UpdateBlockedPlatform = {
  /** Native modal; resolves to the index of the button the user chose. */
  showMessageBox: (options: {
    type: "warning";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
  }) => Promise<{ response: number }>;
  /** Native error box with manual remediation steps. */
  showErrorBox: (title: string, content: string) => void;
  /**
   * Move the running app bundle to /Applications. On success this quits and
   * relaunches, so nothing after a successful call is guaranteed to run.
   */
  moveToApplicationsFolder: () => boolean;
};

/**
 * Host callbacks the controller drives. The packaged-update state and its
 * renderer notification stay owned by the application (single source of truth);
 * the controller only reads/writes through these.
 */
export type UpdateBlockedControllerDeps = {
  getPackagedUpdateState: () => PackagedUpdateState;
  setPackagedUpdateState: (patch: Partial<PackagedUpdateState>) => void;
  notifyPackagedUpdateStatus: () => void;
  telemetry: UpdateBlockedTelemetry;
  platform: UpdateBlockedPlatform;
  /**
   * Fires exactly once each time the fire-and-forget move-to-/Applications
   * dialog flow settles (after a move, a manual-steps fallback, a Later choice,
   * or a swallowed error). Unused in production — the host does not wire it —
   * but lets a test synchronize on the real terminal signal of this floating
   * promise instead of guessing how many event-loop turns it takes to drain
   * (the desktop `test:node` determinism rule).
   */
  onDialogFlowSettled?: () => void;
};

/**
 * Owns the FEA-2349 "update install blocked (read-only volume / App
 * Translocation)" self-resolution flow that was previously inlined in
 * `DesktopApplication`. When an update exists but Squirrel.Mac cannot stage it
 * because the app runs from a read-only mount, this puts the update banner into
 * an actionable error state and offers a once-per-session native dialog that
 * moves Closedloop.app to /Applications for the user.
 *
 * The dialog-shown latch lives here so the flow shows at most one dialog per app
 * session even though update checks repeat every 5 minutes.
 */
export class UpdateBlockedController {
  private dialogShown = false;
  private readonly deps: UpdateBlockedControllerDeps;

  constructor(deps: UpdateBlockedControllerDeps) {
    this.deps = deps;
  }

  /**
   * An update exists but cannot install because the app runs from a read-only
   * volume (App Translocation). Put the update banner into an actionable error
   * state and tell the user how to self-resolve.
   */
  handleUpdateInstallBlocked(version?: string): void {
    gatewayLog.warn(
      "auto-update",
      `Update install blocked (read-only volume) version=${version ?? "unknown"}`
    );
    this.deps.setPackagedUpdateState({
      status: "error",
      available: true,
      downloaded: false,
      version,
      percent: undefined,
      error: formatUpdateBlockedBannerMessage(version),
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });
    this.deps.notifyPackagedUpdateStatus();
    this.deps.telemetry.updateFailed({
      trigger: "install-blocked-read-only-volume",
      status: this.deps.getPackagedUpdateState().status,
      version,
      error: "app is translocated (read-only volume)",
      downloaded: false,
      readyToInstall: false,
    });
    this.showDialogOnce(version);
  }

  /** True when the renderer may offer a "Move to Applications" action. */
  canMoveBlockedUpdateToApplications(): boolean {
    const state = this.deps.getPackagedUpdateState();
    return (
      state.status === "error" &&
      state.installBlockedReason ===
        PackagedUpdateInstallBlockedReason.ReadOnlyVolume
    );
  }

  /** Best-effort move to /Applications; never throws. Returns success. */
  attemptMoveToApplications(): boolean {
    try {
      return this.deps.platform.moveToApplicationsFolder();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      gatewayLog.warn(
        "auto-update",
        `moveToApplicationsFolder failed: ${message}`
      );
    }
    return false;
  }

  /**
   * Native dialog telling the user to move Closedloop.app to /Applications, with
   * a button that does it for them. Shown at most once per app session — update
   * checks repeat every 5 minutes and must not stack dialogs.
   */
  private showDialogOnce(version?: string): void {
    if (this.dialogShown) {
      return;
    }
    this.dialogShown = true;
    this.promptToMoveToApplications(version)
      .catch((error: unknown) => {
        // The dialog flow must never affect the running app.
        const message = error instanceof Error ? error.message : String(error);
        gatewayLog.warn(
          "auto-update",
          `update-blocked dialog failed: ${message}`
        );
      })
      .finally(() => {
        this.deps.onDialogFlowSettled?.();
      });
  }

  private async promptToMoveToApplications(version?: string): Promise<void> {
    const { response } = await this.deps.platform.showMessageBox({
      type: "warning",
      title: UPDATE_BLOCKED_DIALOG_TITLE,
      message: UPDATE_BLOCKED_DIALOG_TITLE,
      detail: formatUpdateBlockedDialogBody(version),
      buttons: [UPDATE_BLOCKED_MOVE_BUTTON, UPDATE_BLOCKED_LATER_BUTTON],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      gatewayLog.info(
        "auto-update",
        "user deferred moving the app to /Applications"
      );
      return;
    }
    const moved = this.attemptMoveToApplications();
    if (moved) {
      return;
    }
    this.showManualSteps(version);
  }

  private showManualSteps(
    version = this.deps.getPackagedUpdateState().version
  ): void {
    this.deps.platform.showErrorBox(
      UPDATE_BLOCKED_DIALOG_TITLE,
      formatUpdateBlockedManualStepsBody(version)
    );
  }
}
