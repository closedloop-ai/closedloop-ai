/**
 * @file agent-dashboard-local-read-ipc.ts
 * @description ISS-4771: the local-SQLite dashboard read channels
 * (`desktop:db:get-*`) — sessions, agents, events, the dashboard rollups,
 * insights, analytics, and diagnostics. Extracted verbatim out of the shrink-only
 * grandfathered `agent-dashboard-design-system-runtime.ts`; every handler body,
 * coercion, and clamp is unchanged.
 */
import { ipcMain } from "electron";
import { coerceDbId } from "../database/ipc-validation.js";
import {
  coerceDashboardWindowRequest,
  coerceInsightsPeriod,
  coerceInsightsSection,
  coerceLookbackDays,
  coerceSessionPageRequest,
} from "./agent-dashboard-ipc-coercion.js";
import {
  DB_HOST_EXIT_REDRIVE_READ,
  type WithDb,
} from "./agent-dashboard-ipc-handler-wrappers.js";

/** Register the local dashboard read channels. */
export function registerLocalDashboardReadIpcHandlers(deps: {
  withDb: WithDb;
}): void {
  const { withDb } = deps;
  ipcMain.handle(
    "desktop:db:get-sessions",
    withDb((agentDatabase) => agentDatabase.sessions.getAll())
  );

  ipcMain.handle(
    "desktop:db:get-sessions-page",
    withDb((agentDatabase, request: unknown) =>
      agentDatabase.sessions.getPage(coerceSessionPageRequest(request))
    )
  );

  ipcMain.handle(
    "desktop:db:get-kanban-pages",
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
    "desktop:db:get-session",
    withDb((agentDatabase, id: unknown) => {
      const sessionId = coerceDbId(id);
      if (sessionId === null) {
        return undefined;
      }
      return agentDatabase.sessions.getById(sessionId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-session-details",
    withDb((agentDatabase, id: unknown) => {
      const sessionId = coerceDbId(id);
      if (sessionId === null) {
        return undefined;
      }
      return agentDatabase.sessions.getDetailsById(sessionId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-agents",
    withDb((agentDatabase, sessionId: unknown) => {
      const id = coerceDbId(sessionId);
      if (id === null) {
        return [];
      }
      return agentDatabase.agents.getBySession(id);
    })
  );

  ipcMain.handle(
    "desktop:db:get-events",
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
    "desktop:db:get-dashboard-summary",
    withDb((agentDatabase) => agentDatabase.getSummary())
  );

  ipcMain.handle(
    "desktop:db:get-sessions-with-details",
    withDb((agentDatabase) => agentDatabase.sessions.getAllWithDetails())
  );

  ipcMain.handle(
    "desktop:db:get-event-feed",
    withDb((agentDatabase) => agentDatabase.events.getAll())
  );

  ipcMain.handle(
    "desktop:db:get-events-with-session",
    withDb((agentDatabase, sessionId: unknown) => {
      const id = coerceDbId(sessionId);
      if (id === null) {
        return [];
      }
      return agentDatabase.events.getWithSession(id);
    })
  );

  ipcMain.handle(
    "desktop:db:get-event-count-by-type",
    withDb((agentDatabase) => agentDatabase.events.getCountByType())
  );

  ipcMain.handle(
    "desktop:db:get-token-analytics",
    withDb((agentDatabase) => agentDatabase.dashboard.getTokenAnalytics())
  );

  ipcMain.handle(
    "desktop:db:get-insights",
    withDb(async (agentDatabase, section: unknown, period: unknown) => {
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
      return await agentDatabase.dashboard.getInsights(
        parsedSection,
        parsedPeriod
      );
    }, DB_HOST_EXIT_REDRIVE_READ)
  );

  ipcMain.handle(
    "desktop:db:get-agent-hierarchy",
    withDb((agentDatabase, sessionId: unknown) => {
      const id = coerceDbId(sessionId);
      if (id === null) {
        return [];
      }
      return agentDatabase.agents.getBySessionWithChildren(id);
    })
  );

  ipcMain.handle(
    "desktop:db:get-analytics",
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
    "desktop:db:get-workflow-data",
    withDb((agentDatabase) => agentDatabase.dashboard.getWorkflowData())
  );

  ipcMain.handle(
    "desktop:db:get-core-features",
    withDb((agentDatabase) => agentDatabase.dashboard.getCoreFeatures())
  );

  ipcMain.handle(
    "desktop:db:get-packs",
    withDb((agentDatabase) => agentDatabase.dashboard.getPacks())
  );

  ipcMain.handle(
    "desktop:db:get-skills",
    withDb((agentDatabase) => agentDatabase.dashboard.getSkills())
  );

  ipcMain.handle(
    "desktop:db:get-tools",
    withDb((agentDatabase) => agentDatabase.dashboard.getTools())
  );

  ipcMain.handle(
    "desktop:db:get-subagents",
    withDb((agentDatabase) => agentDatabase.dashboard.getSubAgents())
  );

  // ISS-5631: paged, like the `desktop:db:get-plans-list` sibling. The window is
  // passed through untrusted and clamped in the query
  // (`coerceDashboardListWindow`), so a renderer cannot request the whole plan
  // corpus — every plan's full markdown `content` — in one IPC response.
  ipcMain.handle(
    "desktop:db:get-plans",
    withDb((agentDatabase, opts: unknown) =>
      agentDatabase.dashboard.getPlans(coerceDashboardWindowRequest(opts))
    )
  );

  // ISS-6451: paged on the same contract. This channel and `getCoreFeatures`
  // each fired the unwindowed read on one Workflow screen load, so the whole
  // PR corpus crossed the db-host IPC boundary twice.
  ipcMain.handle(
    "desktop:db:get-pull-requests",
    withDb((agentDatabase, opts: unknown) =>
      agentDatabase.dashboard.getPullRequests(
        coerceDashboardWindowRequest(opts)
      )
    )
  );

  // --- Diagnostics (FEA-1959) ---
  ipcMain.handle(
    "desktop:db:get-diagnostics",
    withDb((agentDatabase) => agentDatabase.diagnostics.getData())
  );
}
