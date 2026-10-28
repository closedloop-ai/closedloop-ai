/**
 * @file agent-dashboard-db-ipc-registration.ts
 * @description ISS-4771: the registration/unregistration pass for every
 * `desktop:db:*`-family channel the Agent Dashboard runtime owns. Extracted out
 * of `agent-dashboard-design-system-runtime.ts`, which had grown a single
 * ~1,100-line registrar.
 *
 * This module owns only the pass itself: build the shared `withDb`/`withPrisma`
 * wrappers once, then hand them to the per-domain group registrars in the SAME
 * order the monolithic registrar registered them in. Registration order is
 * preserved because `unregisterDesignSystemDbIpcHandlers` runs first and a
 * duplicate `ipcMain.handle` on any of these channels throws.
 */
import { ipcMain } from "electron";
import { SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST } from "../../shared/shared-agent-sessions-contract.js";
import { SHARED_BRANCHES_IPC_CHANNEL_LIST } from "../../shared/shared-branches-contract.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { registerCatalogAndPackIpcHandlers } from "./agent-dashboard-catalog-pack-ipc.js";
import { registerComponentAnalyticsIpcHandlers } from "./agent-dashboard-component-analytics-ipc.js";
import { DESIGN_SYSTEM_DB_IPC_CHANNELS } from "./agent-dashboard-ipc-contract.js";
import { createDbIpcHandlerWrappers } from "./agent-dashboard-ipc-handler-wrappers.js";
import { registerLocalPriorityIpcHandlers } from "./agent-dashboard-local-priority-ipc.js";
import { registerLocalDashboardReadIpcHandlers } from "./agent-dashboard-local-read-ipc.js";
import type {
  AgentDashboardDesignSystemRuntimeOptions,
  InvokeStoreOp,
} from "./agent-dashboard-runtime-options.js";
import { registerSessionViewershipIpcHandlers } from "./agent-dashboard-session-viewership-ipc.js";
import { registerSharedSessionAndBranchIpcHandlers } from "./agent-dashboard-shared-read-ipc.js";

export function registerDesignSystemDbIpcHandlers(
  getAgentDatabase: () => Promise<DbHostAgentDatabase>,
  options: AgentDashboardDesignSystemRuntimeOptions,
  invokeStoreOp: InvokeStoreOp,
  /** ISS-9802 — forward a renderer cancellation token to the db-host child. */
  cancelDbHostRead: (token: string) => void
): void {
  unregisterDesignSystemDbIpcHandlers();
  const { withDb, withPrisma } = createDbIpcHandlerWrappers({
    getAgentDatabase,
    options,
  });

  registerLocalDashboardReadIpcHandlers({ withDb, invokeStoreOp });
  registerCatalogAndPackIpcHandlers({
    withDb,
    withPrisma,
    options,
    invokeStoreOp,
  });
  registerSharedSessionAndBranchIpcHandlers({
    withDb,
    options,
    invokeStoreOp,
    cancelDbHostRead,
  });
  // ISS-7830: thread-viewership capture.
  registerSessionViewershipIpcHandlers({ withDb, invokeStoreOp });
  // ISS-10332: the local-mode priority writes.
  registerLocalPriorityIpcHandlers({
    withDb,
    invokeStoreOp,
    getWindow: options.getWindow,
  });
  registerComponentAnalyticsIpcHandlers({
    withDb,
    withPrisma,
    options,
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
}
