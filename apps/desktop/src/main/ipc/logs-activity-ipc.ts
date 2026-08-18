import type { ActivityLogStore } from "../diagnostics/activity-log-store.js";
import type { LogEntry } from "../logging/gateway-logger.js";

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

type IpcMainLike = {
  handle: (
    channel: LogsActivityIpcChannel,
    listener: (event: unknown, payload?: unknown) => unknown
  ) => void;
};

type LogsActivityIpcDeps = {
  getLogEntries: () => LogEntry[];
  clearLogs: () => void;
  getLogFilePath: () => string;
  openLogFile: () => void;
  activityLog: ActivityLogStore;
};

export function registerLogsActivityIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: LogsActivityIpcDeps
): void {
  ipcMainLike.handle(LogsActivityIpcChannel.GetLogs, () =>
    deps.getLogEntries()
  );
  ipcMainLike.handle(LogsActivityIpcChannel.ClearLogs, () => {
    deps.clearLogs();
  });
  ipcMainLike.handle(LogsActivityIpcChannel.GetLogFilePath, () =>
    deps.getLogFilePath()
  );
  ipcMainLike.handle(LogsActivityIpcChannel.OpenLogFile, () =>
    deps.openLogFile()
  );
  ipcMainLike.handle(LogsActivityIpcChannel.GetActivityEvents, () =>
    deps.activityLog.list()
  );
  ipcMainLike.handle(LogsActivityIpcChannel.ClearActivityEvents, () => {
    deps.activityLog.clear();
    return deps.activityLog.list();
  });
}
