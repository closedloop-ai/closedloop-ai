/** IPC channel names the logs-activity handler registers and the preload bridge invokes. */
export const LogsActivityIpcChannel = {
  GetLogs: "desktop:get-logs",
  ClearLogs: "desktop:clear-logs",
  GetLogFilePath: "desktop:get-log-file-path",
  OpenLogFile: "desktop:open-log-file",
  GetActivityEvents: "desktop:get-activity-events",
  ClearActivityEvents: "desktop:clear-activity-events",
} as const;

export type LogsActivityIpcChannel =
  (typeof LogsActivityIpcChannel)[keyof typeof LogsActivityIpcChannel];
