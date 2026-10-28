import { DebugIpcChannel } from "../../shared/debug-ipc-channel.js";
import type { LocalSessionStore } from "../auth/local-session-store.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

type IpcMainLike = {
  handle: (
    channel: DebugIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type DebugIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  getDangerousAutoApprove: () => boolean;
  setDangerousAutoApprove: (enabled: boolean) => void;
  isDebugAuthEnabled: () => boolean;
  sessionStore: LocalSessionStore;
};

export function registerDebugIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: DebugIpcDeps
): void {
  ipcMainLike.handle(DebugIpcChannel.GetDangerousAutoApprove, () =>
    deps.getDangerousAutoApprove()
  );
  ipcMainLike.handle(
    DebugIpcChannel.SetDangerousAutoApprove,
    (event, enabled) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      deps.setDangerousAutoApprove(Boolean(enabled));
      return deps.getDangerousAutoApprove();
    }
  );
  ipcMainLike.handle(DebugIpcChannel.IsDebugAuthEnabled, () =>
    deps.isDebugAuthEnabled()
  );
  ipcMainLike.handle(DebugIpcChannel.MintDebugToken, (event, origin) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    if (!deps.isDebugAuthEnabled()) {
      throw new Error("Debug auth is not enabled");
    }
    const boundOrigin =
      typeof origin === "string" && origin.trim()
        ? origin.trim()
        : "http://localhost";
    const session = deps.sessionStore.create(boundOrigin);
    return { ...session, origin: boundOrigin };
  });
}
