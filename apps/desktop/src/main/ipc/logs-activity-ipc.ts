import { LogsActivityIpcChannel } from "../../shared/logs-activity-ipc-channel.js";
import type { ActivityLogStore } from "../diagnostics/activity-log-store.js";
import type { LogEntry } from "../logging/gateway-logger.js";

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
