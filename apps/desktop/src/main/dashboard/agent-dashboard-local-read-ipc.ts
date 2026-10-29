/**
 * @file agent-dashboard-local-read-ipc.ts
 * @description ISS-4771: the local-SQLite dashboard read channels
 * (`desktop:db:get-*`) — sessions, agents, events, the dashboard rollups,
 * insights, analytics, and diagnostics. Extracted verbatim out of
 * `agent-dashboard-design-system-runtime.ts`; every handler body,
 * coercion, and clamp is unchanged.
 */
import { ipcMain } from "electron";
import { AgentDashboardDbIpcChannel } from "../../shared/agent-dashboard-db-ipc-channel.js";
import { parseBranchListSnapshot } from "../database/branch-list-snapshot-read.js";
import { coerceDbId } from "../database/ipc-validation.js";
import {
  coerceDashboardWindowRequest,
  coerceDiagnosticsRequest,
  coerceInsightsPeriod,
  coerceInsightsSection,
  coerceLookbackDays,
  coerceSessionPageRequest,
  toBranchSyncSource,
} from "./agent-dashboard-ipc-coercion.js";
import {
  DB_HOST_EXIT_REDRIVE_READ,
  type WithDb,
} from "./agent-dashboard-ipc-handler-wrappers.js";
import type { InvokeStoreOp } from "./agent-dashboard-runtime-options.js";
import {
  isDeliveryInsights,
  withLocalBranchCoverage,
} from "./local-insights-branch-coverage.js";

/** Register the local dashboard read channels. */
export function registerLocalDashboardReadIpcHandlers(deps: {
  withDb: WithDb;
  /** ISS-12256: the Branches page's list snapshot, for the Delivery chart. */
  invokeStoreOp: InvokeStoreOp;
}): void {
  const { withDb, invokeStoreOp } = deps;
  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetSessions,
    withDb((agentDatabase) => agentDatabase.sessions.getAll())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetSessionsPage,
    withDb((agentDatabase, request: unknown) =>
      agentDatabase.sessions.getPage(coerceSessionPageRequest(request))
    )
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetKanbanPages,
    withDb((agentDatabase, statuses: unknown, limit: unknown) => {
      const safeStatuses = Array.isArray(statuses)
        ? statuses.filter((s): s is string => typeof s === "string")
        : [];
      const safeLimit =
        typeof limit === "number" && Number.isInteger(limit)
          ? Math.min(Math.max(limit, 1), 100)
          : 25;
      return agentDatabase.sessions.getKanbanPages(safeStatuses, safeLimit);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetSession,
    withDb((agentDatabase, id: unknown) => {
      const sessionId = coerceDbId(id);
      if (sessionId === null) {
        return undefined;
      }
      return agentDatabase.sessions.getById(sessionId);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetSessionDetails,
    withDb((agentDatabase, id: unknown) => {
      const sessionId = coerceDbId(id);
      if (sessionId === null) {
        return undefined;
      }
      return agentDatabase.sessions.getDetailsById(sessionId);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetAgents,
    withDb((agentDatabase, sessionId: unknown) => {
      const id = coerceDbId(sessionId);
      if (id === null) {
        return [];
      }
      return agentDatabase.agents.getBySession(id);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetEvents,
    withDb((agentDatabase, sessionId: unknown, agentId?: unknown) => {
      const sid = coerceDbId(sessionId);
      if (sid === null) {
        return [];
      }
      const aid = coerceDbId(agentId);
      if (aid !== null) {
        return agentDatabase.events.getBySessionAndAgent(sid, aid);
      }
      return agentDatabase.events.getBySession(sid);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetDashboardSummary,
    withDb((agentDatabase) => agentDatabase.getSummary())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetSessionsWithDetails,
    withDb((agentDatabase) => agentDatabase.sessions.getAllWithDetails())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetEventFeed,
    withDb((agentDatabase) => agentDatabase.events.getAll())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetEventsWithSession,
    withDb((agentDatabase, sessionId: unknown) => {
      const id = coerceDbId(sessionId);
      if (id === null) {
        return [];
      }
      return agentDatabase.events.getWithSession(id);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetEventCountByType,
    withDb((agentDatabase) => agentDatabase.events.getCountByType())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetTokenAnalytics,
    withDb((agentDatabase) => agentDatabase.dashboard.getTokenAnalytics())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetInsights,
    withDb(
      async (
        agentDatabase,
        section: unknown,
        period: unknown,
        // Ignored — see the scope note below.
        _scope: unknown
      ) => {
        const parsedSection = coerceInsightsSection(section);
        const parsedPeriod = coerceInsightsPeriod(period);
        // PLN-1138 Phase 3: this handler is the LOCAL (own-data) insights read
        // only. Authenticated cloud reads (`me` and `org`) now flow through the
        // renderer's shared HTTP insights source over the D-G IPC fetch bridge,
        // not through a bespoke main-process cloud fetch. The renderer only
        // dispatches here in Local mode (signed out / offline), which is
        // personal-scope by construction, so scope no longer reaches this handler.
        //
        // Concurrency is bounded on the db-host side: this call dispatches to the
        // worker's `dashboard.getInsights` op, which runs behind the FEA-2055
        // `InsightsResultCache` (see insights-cache.ts). That gate caps how many
        // heavy metadata scans compute at once (default 1) at the compute-miss
        // boundary — AFTER its fresh/stale-serve fast returns — so a burst of
        // section widgets can't stampede the worker's heap, while cache hits
        // during backfill still return immediately.
        // No fixed clock from this path — the store's own clock is the default
        // (ISS-9279). ISS-10541 removed the date-basis argument that used to
        // follow it: the renderer can no longer choose a column.
        const insights = await agentDatabase.dashboard.getInsights(
          parsedSection,
          parsedPeriod
        );
        // ISS-12256: the Delivery Branch coverage chart counts the local
        // Branches list's own population for the range, read here in main
        // where the list's read lives.
        return isDeliveryInsights(insights)
          ? await withLocalBranchCoverage(
              insights,
              toBranchSyncSource(agentDatabase),
              parsedPeriod,
              async (snapshotRequest) =>
                parseBranchListSnapshot(
                  await invokeStoreOp("branches.listSnapshot", [
                    snapshotRequest,
                  ])
                )
            )
          : insights;
      },
      DB_HOST_EXIT_REDRIVE_READ
    )
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetAgentHierarchy,
    withDb((agentDatabase, sessionId: unknown) => {
      const id = coerceDbId(sessionId);
      if (id === null) {
        return [];
      }
      return agentDatabase.agents.getBySessionWithChildren(id);
    })
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetAnalytics,
    withDb((agentDatabase, lookbackDays: unknown) =>
      // FEA-3722: forward the renderer's selected date range (or default/all-time
      // sentinel) so the Coding Wrap windows to the same 7d/30d/90d/All selector.
      agentDatabase.dashboard.getAnalytics(
        undefined,
        coerceLookbackDays(lookbackDays)
      )
    )
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetWorkflowData,
    withDb((agentDatabase) => agentDatabase.dashboard.getWorkflowData())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetCoreFeatures,
    withDb((agentDatabase) => agentDatabase.dashboard.getCoreFeatures())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPacks,
    withDb((agentDatabase) => agentDatabase.dashboard.getPacks())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetSkills,
    withDb((agentDatabase) => agentDatabase.dashboard.getSkills())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetTools,
    withDb((agentDatabase) => agentDatabase.dashboard.getTools())
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetSubagents,
    withDb((agentDatabase) => agentDatabase.dashboard.getSubAgents())
  );

  // ISS-5631: paged, like the `desktop:db:get-plans-list` sibling. The window is
  // passed through untrusted and clamped in the query
  // (`coerceDashboardListWindow`), so a renderer cannot request the whole plan
  // corpus — every plan's full markdown `content` — in one IPC response.
  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPlans,
    withDb((agentDatabase, opts: unknown) =>
      agentDatabase.dashboard.getPlans(coerceDashboardWindowRequest(opts))
    )
  );

  // ISS-6451: paged on the same contract. This channel and `getCoreFeatures`
  // each fired the unwindowed read on one Workflow screen load, so the whole
  // PR corpus crossed the db-host IPC boundary twice.
  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetPullRequests,
    withDb((agentDatabase, opts: unknown) =>
      agentDatabase.dashboard.getPullRequests(
        coerceDashboardWindowRequest(opts)
      )
    )
  );

  // --- Diagnostics (FEA-1959) ---
  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetDiagnostics,
    withDb((agentDatabase, request: unknown) =>
      agentDatabase.diagnostics.getData(coerceDiagnosticsRequest(request))
    )
  );
}
