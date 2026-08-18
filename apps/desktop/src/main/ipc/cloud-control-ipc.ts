import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";
export const CloudControlIpcChannel = {
  GetCloudCommandsPaused: "desktop:get-cloud-commands-paused",
  SetCloudCommandsPaused: "desktop:set-cloud-commands-paused",
  GetCloudConnectionEnabled: "desktop:get-cloud-connection-enabled",
  SetCloudConnectionEnabled: "desktop:set-cloud-connection-enabled",
} as const;

export type CloudControlIpcChannel =
  (typeof CloudControlIpcChannel)[keyof typeof CloudControlIpcChannel];

type IpcMainLike = {
  handle: (
    channel: CloudControlIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type CloudControlIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  getCloudCommandsPaused: () => boolean;
  setCloudCommandsPaused: (paused: boolean) => void;
  getCloudConnectionEnabled: () => boolean;
  setCloudConnectionEnabled: (enabled: boolean) => void;
};

export function registerCloudControlIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: CloudControlIpcDeps
): void {
  ipcMainLike.handle(CloudControlIpcChannel.GetCloudCommandsPaused, () =>
    deps.getCloudCommandsPaused()
  );
  ipcMainLike.handle(
    CloudControlIpcChannel.SetCloudCommandsPaused,
    (event, paused) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      deps.setCloudCommandsPaused(Boolean(paused));
      // Read back the post-set field: the setter is the source of truth.
      return { paused: deps.getCloudCommandsPaused() };
    }
  );
  ipcMainLike.handle(CloudControlIpcChannel.GetCloudConnectionEnabled, () =>
    deps.getCloudConnectionEnabled()
  );
  ipcMainLike.handle(
    CloudControlIpcChannel.SetCloudConnectionEnabled,
    (event, enabled) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      deps.setCloudConnectionEnabled(Boolean(enabled));
      return { enabled: deps.getCloudConnectionEnabled() };
    }
  );
}
