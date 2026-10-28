/** IPC channel names the runtime-info handler registers and the preload bridge invokes. */
export const RuntimeInfoIpcChannel = {
  GetAppVersion: "desktop:get-app-version",
  GetAllFlags: "desktop:get-all-flags",
  GetTranscriptSyncStatus: "desktop:get-transcript-sync-status",
  GetRuntimeStatus: "desktop:get-runtime-status",
} as const;

export type RuntimeInfoIpcChannel =
  (typeof RuntimeInfoIpcChannel)[keyof typeof RuntimeInfoIpcChannel];
