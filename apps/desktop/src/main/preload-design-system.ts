import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { ipcRenderer } from "electron";
import type {
  AgentHierarchyNode,
  AgentRow,
  AnalyticsData,
  CatalogEntry,
  CatalogMutationResult,
  DashboardCoreFeatures,
  DashboardPackSummary,
  DashboardPlanSummary,
  DashboardPullRequestSummary,
  DashboardSkillSummary,
  DashboardSubAgentSummary,
  DashboardSummary,
  DashboardToolSummary,
  EventCountByType,
  EventRow,
  EventWithSession,
  InstalledPack,
  InstalledPackDetail,
  InstallOutputChunk,
  InstallRunRecord,
  KanbanPages,
  PlanRecord,
  PlanVersionRecord,
  PrRecord,
  PrSessionGroup,
  PrStats,
  SessionPage,
  SessionPageRequest,
  SessionRow,
  SessionWithAgents,
  SkillInvocation,
  SkillWithInvocations,
  TokenAnalytics,
  WorkflowQueryData,
} from "../shared/agent-db-contract.js";
import type { DiagnosticsData } from "../shared/diagnostics-contract.js";
import {
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
  type SharedAgentSessionAnalytics,
  type SharedAgentSessionDetail,
  type SharedAgentSessionListResponse,
  type SharedAgentSessionsListRequest,
  type SharedAgentSessionsQuery,
  type SharedAgentSessionUsageSummary,
} from "../shared/shared-agent-sessions-contract.js";
import {
  SHARED_BRANCHES_IPC_CHANNELS,
  type SharedBranchesListRequest,
  type SharedBranchesQuery,
} from "../shared/shared-branches-contract.js";
import { exposeDesktopApi } from "./preload-common.js";

type DbChangePayload = { sessionId?: string };
type RendererIdleScheduler = typeof globalThis & {
  requestIdleCallback?: (callback: () => void) => number;
  requestAnimationFrame?: (callback: () => void) => number;
};
type RendererInteractionTarget = typeof globalThis & {
  addEventListener?: (
    eventName: string,
    listener: () => void,
    options?: RendererInteractionListenerOptions
  ) => void;
};
type RendererInteractionListenerOptions = {
  capture?: boolean;
  passive?: boolean;
};

const dbChangeSubscribers = new Set<(payload: DbChangePayload) => void>();
let liveDbReady = false;
let liveDbInFlightCount = 0;
let rendererLiveDbIdleScheduled = false;
let rendererLiveDbIdleNotified = false;
let lastRendererInteractionReportedAt = 0;

ipcRenderer.on("desktop:db:ready", () => {
  liveDbReady = true;
  notifyDbChangeSubscribers({});
});

ipcRenderer.on(
  "desktop:db:changed",
  (_event: unknown, payload: DbChangePayload = {}) => {
    notifyDbChangeSubscribers(payload);
  }
);

const designSystemDashboardApi = {
  agentSessionsApi: {
    list: (request?: SharedAgentSessionsListRequest) =>
      invokeLiveDb<SharedAgentSessionListResponse>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.list,
        request
      ),
    detail: (id: string) =>
      invokeLiveDb<SharedAgentSessionDetail | null>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail,
        id
      ),
    usage: (request?: SharedAgentSessionsQuery) =>
      invokeLiveDb<SharedAgentSessionUsageSummary>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage,
        request
      ),
    analytics: (request?: SharedAgentSessionsQuery) =>
      invokeLiveDb<SharedAgentSessionAnalytics>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics,
        request
      ),
  },
  branchesApi: {
    list: (request?: SharedBranchesListRequest) =>
      invokeLiveDb<BranchListResponse>(
        SHARED_BRANCHES_IPC_CHANNELS.list,
        request
      ),
    detail: (id: string) =>
      invokeLiveDb<BranchPageDetail | null>(
        SHARED_BRANCHES_IPC_CHANNELS.detail,
        id
      ),
    usage: (request?: SharedBranchesQuery) =>
      invokeLiveDb<BranchUsageSummary>(
        SHARED_BRANCHES_IPC_CHANNELS.usage,
        request
      ),
    analytics: (request?: SharedBranchesQuery) =>
      invokeLiveDb<BranchAnalytics>(
        SHARED_BRANCHES_IPC_CHANNELS.analytics,
        request
      ),
  },
  db: {
    getSessions: () => invokeLiveDb<SessionRow[]>("desktop:db:get-sessions"),
    getSession: (id: string) =>
      invokeLiveDb<SessionRow | undefined>("desktop:db:get-session", id),
    getSessionDetails: (id: string) =>
      invokeLiveDb<SessionWithAgents | undefined>(
        "desktop:db:get-session-details",
        id
      ),
    getAgents: (sessionId: string) =>
      invokeLiveDb<AgentRow[]>("desktop:db:get-agents", sessionId),
    getEvents: (sessionId: string, agentId?: string) =>
      invokeLiveDb<EventRow[]>("desktop:db:get-events", sessionId, agentId),
    getDashboardSummary: () =>
      invokeLiveDb<DashboardSummary>("desktop:db:get-dashboard-summary"),
    getInsights: (section: string, period: string, scope?: string) =>
      invokeLiveDb("desktop:db:get-insights", section, period, scope),
    getSessionsWithDetails: () =>
      invokeLiveDb<SessionWithAgents[]>("desktop:db:get-sessions-with-details"),
    getSessionsPage: (request?: SessionPageRequest) =>
      invokeLiveDb<SessionPage>("desktop:db:get-sessions-page", request),
    getKanbanPages: (statuses: string[], limit: number) =>
      invokeLiveDb<KanbanPages>("desktop:db:get-kanban-pages", statuses, limit),
    getEventFeed: () =>
      invokeLiveDb<EventWithSession[]>("desktop:db:get-event-feed"),
    getEventsWithSession: (sessionId: string) =>
      invokeLiveDb<EventWithSession[]>(
        "desktop:db:get-events-with-session",
        sessionId
      ),
    getEventCountByType: () =>
      invokeLiveDb<EventCountByType[]>("desktop:db:get-event-count-by-type"),
    getTokenAnalytics: () =>
      invokeLiveDb<TokenAnalytics>("desktop:db:get-token-analytics"),
    getAgentHierarchy: (sessionId: string) =>
      invokeLiveDb<AgentHierarchyNode[]>(
        "desktop:db:get-agent-hierarchy",
        sessionId
      ),
    getAnalytics: () => invokeLiveDb<AnalyticsData>("desktop:db:get-analytics"),
    getWorkflowData: () =>
      invokeLiveDb<WorkflowQueryData>("desktop:db:get-workflow-data"),
    getCoreFeatures: () =>
      invokeLiveDb<DashboardCoreFeatures>("desktop:db:get-core-features"),
    getPacks: () =>
      invokeLiveDb<DashboardPackSummary[]>("desktop:db:get-packs"),
    getSkills: () =>
      invokeLiveDb<DashboardSkillSummary[]>("desktop:db:get-skills"),
    getTools: () =>
      invokeLiveDb<DashboardToolSummary[]>("desktop:db:get-tools"),
    getSubAgents: () =>
      invokeLiveDb<DashboardSubAgentSummary[]>("desktop:db:get-subagents"),
    getPlans: () =>
      invokeLiveDb<DashboardPlanSummary[]>("desktop:db:get-plans"),
    getPullRequests: () =>
      invokeLiveDb<DashboardPullRequestSummary[]>(
        "desktop:db:get-pull-requests"
      ),

    // Diagnostics (FEA-1959)
    getDiagnostics: () =>
      invokeLiveDb<DiagnosticsData>("desktop:db:get-diagnostics"),

    // Catalog (FEA-1314)
    getCatalog: () => invokeLiveDb<CatalogEntry[]>("desktop:db:get-catalog"),
    getCatalogEntry: (packId: string) =>
      invokeLiveDb<CatalogEntry | null>("desktop:db:get-catalog-entry", packId),
    getCatalogReadme: (packId: string) =>
      invokeLiveDb<string | null>("desktop:db:get-catalog-readme", packId),
    getCatalogContents: (packId: string) =>
      invokeLiveDb<unknown[] | null>("desktop:db:get-catalog-contents", packId),
    getCatalogHistory: (packId: string) =>
      invokeLiveDb<Array<{ fetchedAt: string; stars: number; forks: number }>>(
        "desktop:db:get-catalog-history",
        packId
      ),
    catalogInstall: (packId: string, harness: string, cwd?: string) =>
      invokeLiveDb<CatalogMutationResult>(
        "desktop:db:catalog-install",
        packId,
        harness,
        cwd
      ),
    catalogUninstall: (packId: string, harness: string, cwd?: string) =>
      invokeLiveDb<CatalogMutationResult>(
        "desktop:db:catalog-uninstall",
        packId,
        harness,
        cwd
      ),
    catalogRefresh: () => invokeLiveDb<void>("desktop:db:catalog-refresh"),
    getInstallRuns: (packId?: string) =>
      invokeLiveDb<InstallRunRecord[]>("desktop:db:get-install-runs", packId),

    // Installed packs (FEA-1224)
    getInstalledPacks: () =>
      invokeLiveDb<InstalledPack[]>("desktop:db:get-installed-packs"),
    getPackDetail: (packId: string) =>
      invokeLiveDb<InstalledPackDetail | null>(
        "desktop:db:get-pack-detail",
        packId
      ),
    getPackSessions: (packId: string) =>
      invokeLiveDb<unknown[]>("desktop:db:get-pack-sessions", packId),
    getAllSkills: () =>
      invokeLiveDb<SkillWithInvocations[]>("desktop:db:get-all-skills"),
    getSkillInvocations: (name: string) =>
      invokeLiveDb<SkillInvocation[]>("desktop:db:get-skill-invocations", name),
    getRecentProjects: () =>
      invokeLiveDb<string[]>("desktop:db:get-recent-projects"),

    // Plans (FEA-1189)
    getPlansList: (opts?: {
      sessionId?: string;
      needsConfirmation?: boolean;
      limit?: number;
      offset?: number;
    }) => invokeLiveDb<PlanRecord[]>("desktop:db:get-plans-list", opts),
    getPlan: (id: string) =>
      invokeLiveDb<PlanRecord | null>("desktop:db:get-plan", id),
    getPlanVersions: (planId: string) =>
      invokeLiveDb<PlanVersionRecord[]>("desktop:db:get-plan-versions", planId),
    confirmPlan: (id: string) =>
      invokeLiveDb<void>("desktop:db:confirm-plan", id),
    rejectPlan: (id: string) =>
      invokeLiveDb<void>("desktop:db:reject-plan", id),
    openPlan: (id: string, target?: string) =>
      invokeLiveDb<void>("desktop:db:open-plan", id, target),

    // Pull Requests (FEA-1226)
    getPrStats: () => invokeLiveDb<PrStats>("desktop:db:get-pr-stats"),
    getPrSessions: (opts?: { limit?: number; offset?: number }) =>
      invokeLiveDb<PrSessionGroup[]>("desktop:db:get-pr-sessions", opts),
    getPrList: (opts?: {
      sessionId?: string;
      repo?: string;
      limit?: number;
      offset?: number;
    }) => invokeLiveDb<PrRecord[]>("desktop:db:get-pr-list", opts),
    openPr: (id: string) => invokeLiveDb<void>("desktop:db:open-pr", id),
  },
  /**
   * Subscribe to in-process DB-change pushes. The design renderer listens for
   * these events to refresh DB-backed query state without polling.
   */
  onDbChanged: (callback: (payload: { sessionId?: string }) => void) => {
    dbChangeSubscribers.add(callback);
    return () => {
      dbChangeSubscribers.delete(callback);
    };
  },
  /** Subscribe to streamed pack install/uninstall output (FEA-1314). */
  onInstallOutput: (callback: (payload: InstallOutputChunk) => void) => {
    const handler = (_event: unknown, payload: InstallOutputChunk) =>
      callback(payload);
    ipcRenderer.on("desktop:pack:install-output", handler);
    return () =>
      ipcRenderer.removeListener("desktop:pack:install-output", handler);
  },
};

exposeDesktopApi(designSystemDashboardApi);

function notifyDbChangeSubscribers(payload: DbChangePayload): void {
  for (const callback of dbChangeSubscribers) {
    callback(payload);
  }
}

function invokeLiveDb<TResult>(
  channel: string,
  ...args: unknown[]
): Promise<TResult> {
  liveDbInFlightCount += 1;
  return (ipcRenderer.invoke(channel, ...args) as Promise<TResult>).finally(
    () => {
      liveDbInFlightCount = Math.max(0, liveDbInFlightCount - 1);
      if (liveDbReady && liveDbInFlightCount === 0) {
        scheduleRendererLiveDbIdleNotification();
      }
    }
  );
}

function scheduleRendererLiveDbIdleNotification(): void {
  if (
    liveDbInFlightCount > 0 ||
    rendererLiveDbIdleScheduled ||
    rendererLiveDbIdleNotified
  ) {
    return;
  }

  rendererLiveDbIdleScheduled = true;
  const scheduler = globalThis as RendererIdleScheduler;
  const notify = (): void => {
    rendererLiveDbIdleScheduled = false;
    if (rendererLiveDbIdleNotified) {
      return;
    }
    if (liveDbInFlightCount > 0) {
      scheduleRendererLiveDbIdleNotification();
      return;
    }
    rendererLiveDbIdleNotified = true;
    ipcRenderer.send("desktop:renderer-live-db-idle");
  };

  if (typeof scheduler.requestIdleCallback === "function") {
    scheduler.requestIdleCallback(notify);
    return;
  }

  if (typeof scheduler.requestAnimationFrame === "function") {
    scheduler.requestAnimationFrame(() => {
      scheduler.requestAnimationFrame?.(notify);
    });
    return;
  }

  queueMicrotask(notify);
}

function installRendererInteractionReporter(): void {
  const target = globalThis as RendererInteractionTarget;
  if (typeof target.addEventListener !== "function") {
    return;
  }

  const reportInteraction = (): void => {
    const now = Date.now();
    if (
      now - lastRendererInteractionReportedAt <
      RENDERER_INTERACTION_REPORT_THROTTLE_MS
    ) {
      return;
    }
    lastRendererInteractionReportedAt = now;
    ipcRenderer.send("desktop:renderer-user-input");
  };

  for (const eventName of RENDERER_INTERACTION_EVENTS) {
    target.addEventListener(eventName, reportInteraction, {
      capture: true,
      passive: true,
    });
  }
}

const RENDERER_INTERACTION_EVENTS = [
  "keydown",
  "pointerdown",
  "scroll",
  "touchstart",
  "wheel",
] as const;
const RENDERER_INTERACTION_REPORT_THROTTLE_MS = 250;

installRendererInteractionReporter();
