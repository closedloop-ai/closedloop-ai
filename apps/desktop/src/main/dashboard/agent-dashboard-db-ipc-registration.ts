/**
 * @file agent-dashboard-db-ipc-registration.ts
 * @description ISS-4771: the registration/unregistration pass for every
 * `desktop:db:*`-family channel the Agent Dashboard runtime owns. Extracted out
 * of the shrink-only grandfathered `agent-dashboard-design-system-runtime.ts`,
 * which had grown a single ~1,100-line registrar.
 *
 * This module owns only the pass itself: build the shared `withDb`/`withPrisma`
 * wrappers once, then hand them to the per-domain group registrars in the SAME
 * order the monolithic registrar registered them in. Registration order is
 * preserved because `unregisterDesignSystemDbIpcHandlers` runs first and a
 * duplicate `ipcMain.handle` on any of these channels throws.
 */
import { ipcMain } from "electron";
import { SCHEDULED_TASKS_IPC_CHANNEL_LIST } from "../../shared/scheduled-tasks-channel.js";
import { SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST } from "../../shared/shared-agent-sessions-contract.js";
import { SHARED_BRANCHES_IPC_CHANNEL_LIST } from "../../shared/shared-branches-contract.js";
import { SHARED_TRACE_COMMENTS_IPC_CHANNEL_LIST } from "../../shared/shared-trace-comments-contract.js";
import {
  type BranchCloudHydrationSource,
  FAIL_CLOSED_BRANCH_CLOUD_HYDRATION_SOURCE,
} from "../branch/shared-branches-cloud-hydration.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { registerCatalogAndPackIpcHandlers } from "./agent-dashboard-catalog-pack-ipc.js";
import { registerComponentAnalyticsIpcHandlers } from "./agent-dashboard-component-analytics-ipc.js";
import { DESIGN_SYSTEM_DB_IPC_CHANNELS } from "./agent-dashboard-ipc-contract.js";
import { createDbIpcHandlerWrappers } from "./agent-dashboard-ipc-handler-wrappers.js";
import { registerLocalDashboardReadIpcHandlers } from "./agent-dashboard-local-read-ipc.js";
import type {
  AgentDashboardDesignSystemRuntimeOptions,
  InvokeStoreOp,
} from "./agent-dashboard-runtime-options.js";
import { registerScheduledTasksIpcHandlers } from "./agent-dashboard-scheduled-tasks-ipc.js";
import { registerSharedSessionAndBranchIpcHandlers } from "./agent-dashboard-shared-read-ipc.js";
import { registerTraceCommentIpcHandlers } from "./agent-dashboard-trace-comment-ipc.js";

export function registerDesignSystemDbIpcHandlers(
  getAgentDatabase: () => Promise<DbHostAgentDatabase>,
  options: AgentDashboardDesignSystemRuntimeOptions,
  invokeStoreOp: InvokeStoreOp,
  cloudHydration: BranchCloudHydrationSource | undefined
): void {
  unregisterDesignSystemDbIpcHandlers();
  const branchEligibilitySource =
    cloudHydration ?? FAIL_CLOSED_BRANCH_CLOUD_HYDRATION_SOURCE;

  const { withDb, withPrisma } = createDbIpcHandlerWrappers({
    getAgentDatabase,
    options,
  });

  registerLocalDashboardReadIpcHandlers({ withDb });
  registerCatalogAndPackIpcHandlers({
    withDb,
    withPrisma,
    options,
    invokeStoreOp,
  });
  registerSharedSessionAndBranchIpcHandlers({
    withDb,
    options,
    cloudHydration: branchEligibilitySource,
  });
  registerTraceCommentIpcHandlers({ withDb, options, invokeStoreOp });
  registerScheduledTasksIpcHandlers({ withDb });
  registerComponentAnalyticsIpcHandlers({
    withDb,
    withPrisma,
    options,
    branchEligibilitySource,
  });
}

export function unregisterDesignSystemDbIpcHandlers(): void {
  for (const channel of DESIGN_SYSTEM_DB_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
  for (const channel of SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST) {
    ipcMain.removeHandler(channel);
  }
  for (const channel of SHARED_BRANCHES_IPC_CHANNEL_LIST) {
    ipcMain.removeHandler(channel);
  }
  for (const channel of SHARED_TRACE_COMMENTS_IPC_CHANNEL_LIST) {
    ipcMain.removeHandler(channel);
  }
  // FEA-3814 (PRD-553 M2): the read-only Scheduled Tasks channels.
  for (const channel of SCHEDULED_TASKS_IPC_CHANNEL_LIST) {
    ipcMain.removeHandler(channel);
  }
}
