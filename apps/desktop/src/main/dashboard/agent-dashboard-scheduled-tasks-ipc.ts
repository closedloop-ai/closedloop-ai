/**
 * @file agent-dashboard-scheduled-tasks-ipc.ts
 * @description ISS-4771: the crewd scheduled-tasks IPC channels. Extracted
 * verbatim out of the shrink-only grandfathered
 * `agent-dashboard-design-system-runtime.ts`; every write still validates its
 * payload with the crewd Zod schema at this boundary.
 */
import { ipcMain } from "electron";
import {
  coerceScheduledTaskId,
  coerceScheduledTaskRunsRequest,
  ScheduledTasksIpcChannel,
  scheduledTaskSaveSchema,
  schedulePreviewRequestSchema,
} from "../../shared/scheduled-tasks-channel.js";
import type { WithDb } from "./agent-dashboard-ipc-handler-wrappers.js";

/** Register the read-only-plus-writes Scheduled Tasks channels. */
export function registerScheduledTasksIpcHandlers(deps: {
  withDb: WithDb;
}): void {
  const { withDb } = deps;
  // --- Scheduled Tasks (FEA-3852/3853/3854 / PRD-553) ---
  // Reads + writes over the crewd scheduler's SQLite-mirrored in-memory store,
  // which lives in the db host (its writer connection can't cross the proxy). The
  // proxy methods return plain clone-safe values, so `withDb` forwards them. Every
  // handler is trusted-sender-gated by `withDb` (rejects untrusted senders before
  // touching the store); every write validates its payload with the crewd Zod
  // schema at this boundary, so a malformed renderer payload is rejected, not
  // coerced. Each store mutation pushes `desktop:scheduled-tasks:changed`, so the
  // UI refetches list + runs.
  ipcMain.handle(
    ScheduledTasksIpcChannel.List,
    withDb((agentDatabase) => agentDatabase.scheduler.list())
  );
  ipcMain.handle(
    ScheduledTasksIpcChannel.Runs,
    withDb((agentDatabase, request: unknown) => {
      const { taskId, limit } = coerceScheduledTaskRunsRequest(request);
      return agentDatabase.scheduler.runs(taskId, limit);
    })
  );
  ipcMain.handle(
    ScheduledTasksIpcChannel.Create,
    withDb((agentDatabase, payload: unknown) => {
      const input = scheduledTaskSaveSchema.parse(payload);
      // Create: strip any client-sent id so the store mints a fresh one.
      const { id: _ignored, ...create } = input;
      return agentDatabase.scheduler.upsert(create);
    })
  );
  ipcMain.handle(
    ScheduledTasksIpcChannel.Update,
    withDb((agentDatabase, payload: unknown) => {
      const input = scheduledTaskSaveSchema.parse(payload);
      if (!input.id) {
        throw new Error("update requires a task id");
      }
      return agentDatabase.scheduler.upsert(input);
    })
  );
  ipcMain.handle(
    ScheduledTasksIpcChannel.Delete,
    withDb((agentDatabase, id: unknown) => {
      const taskId = coerceScheduledTaskId(id);
      if (taskId === null) {
        return false;
      }
      return agentDatabase.scheduler.remove(taskId);
    })
  );
  ipcMain.handle(
    ScheduledTasksIpcChannel.Toggle,
    withDb((agentDatabase, id: unknown, enabled: unknown) => {
      const taskId = coerceScheduledTaskId(id);
      if (taskId === null) {
        return null;
      }
      return agentDatabase.scheduler.setEnabled(taskId, enabled === true);
    })
  );
  ipcMain.handle(
    ScheduledTasksIpcChannel.RunNow,
    withDb((agentDatabase, id: unknown) => {
      const taskId = coerceScheduledTaskId(id);
      if (taskId === null) {
        return false;
      }
      return agentDatabase.scheduler.runNow(taskId);
    })
  );
  ipcMain.handle(
    ScheduledTasksIpcChannel.PreviewSchedule,
    withDb((agentDatabase, payload: unknown) => {
      const { cron, timezone, count } =
        schedulePreviewRequestSchema.parse(payload);
      return agentDatabase.scheduler.previewSchedule(cron, timezone, count);
    })
  );
}
