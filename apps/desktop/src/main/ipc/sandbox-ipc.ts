import { dialog } from "electron";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";
import { inspectSandboxPath } from "./sandbox-inspect.js";

export const SandboxIpcChannel = {
  PickSandboxDirectory: "desktop:pick-sandbox-directory",
  InspectSandboxPath: "desktop:inspect-sandbox-path",
} as const;

export type SandboxIpcChannel =
  (typeof SandboxIpcChannel)[keyof typeof SandboxIpcChannel];

type IpcMainLike = {
  handle: (
    channel: SandboxIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type SandboxIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
};

export function registerSandboxIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: SandboxIpcDeps
): void {
  ipcMainLike.handle(SandboxIpcChannel.PickSandboxDirectory, async (event) => {
    // Gate on sender trust like the other desktop:* handlers so an untrusted
    // frame cannot pop the native directory picker.
    assertTrustedIpcSender(deps.isTrustedSender, event);
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return inspectSandboxPath(result.filePaths[0]);
  });
  ipcMainLike.handle(
    SandboxIpcChannel.InspectSandboxPath,
    (event, targetPath) => {
      // Gate on sender trust so an untrusted frame cannot probe arbitrary
      // filesystem paths for git repositories via the renderer-supplied path.
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (typeof targetPath !== "string") {
        return null;
      }
      const trimmed = targetPath.trim();
      if (!trimmed) {
        return null;
      }
      return inspectSandboxPath(trimmed);
    }
  );
}
