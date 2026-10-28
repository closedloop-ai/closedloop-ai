/** IPC channel names the cloud-control handler registers and the preload bridge invokes. */
export const CloudControlIpcChannel = {
  GetCloudCommandsPaused: "desktop:get-cloud-commands-paused",
  SetCloudCommandsPaused: "desktop:set-cloud-commands-paused",
  GetCloudConnectionEnabled: "desktop:get-cloud-connection-enabled",
  SetCloudConnectionEnabled: "desktop:set-cloud-connection-enabled",
} as const;

export type CloudControlIpcChannel =
  (typeof CloudControlIpcChannel)[keyof typeof CloudControlIpcChannel];
