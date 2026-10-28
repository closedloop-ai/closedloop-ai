import { DesktopDevModeIpcChannel } from "../../shared/desktop-dev-mode-channel.js";
import { isTrustedIpcSender } from "./ipc-trusted-sender.js";

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type DesktopDevModeIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  /** Validates and stores the payload; see `desktop-feature-flag-dev-mode.ts`. */
  setOverrides: (payload: unknown) => void;
  readCheckedKeys: () => string[];
};

/**
 * ISS-12048: the renderer's Dev Tools overrides in, main's checked flag keys
 * out. Only the trusted renderer window may write overrides; anything else is
 * refused before the payload is read. The payload itself is untrusted even
 * from that window, and main applies it only under its own eligibility check.
 */
export function registerDesktopDevModeIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: DesktopDevModeIpcDeps
): void {
  ipcMainLike.handle(
    DesktopDevModeIpcChannel.SetFeatureFlagOverrides,
    (event, payload) => {
      if (!isTrustedIpcSender(deps.isTrustedSender, event)) {
        return false;
      }
      deps.setOverrides(payload);
      return true;
    }
  );

  ipcMainLike.handle(
    DesktopDevModeIpcChannel.GetCheckedFeatureFlags,
    (event) =>
      isTrustedIpcSender(deps.isTrustedSender, event)
        ? deps.readCheckedKeys()
        : []
  );
}
