import type {
  AgentComponentDetail,
  AgentComponentListResponse,
  AgentComponentQueryFilters,
  ComponentModelTrendResponse,
  SkillLoadedResponse,
  SubagentFrequencyResponse,
} from "@repo/api/src/types/agent-component";
import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
} from "@repo/api/src/types/branch";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import type {
  ConvertInstallOutcome,
  ConvertInstallRequest,
} from "@repo/api/src/types/convert-install";
import type { OptInDistributionDto } from "@repo/api/src/types/distribution";
import { ipcRenderer } from "electron";
import type { GitHubResyncNudgeRendererEvent } from "../renderer/types/desktop-api.js";
import type {
  AgentHierarchyNode,
  AgentRow,
  AnalyticsData,
  CatalogEntry,
  CatalogMutationResult,
  DashboardCoreFeatures,
  DashboardListWindow,
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
import {
  type DbGuardedChannel,
  type NotDbGuarded,
  rejectIfDbHostShuttingDown,
} from "../shared/db-host-shutdown-contract.js";
import type { DiagnosticsData } from "../shared/diagnostics-contract.js";
import { DistributionsIpcChannel } from "../shared/distributions-channel.js";
import { PACK_ANALYTICS_IPC_CHANNEL } from "../shared/pack-analytics-channel.js";
import { SHARED_AGENT_COMPONENTS_IPC_CHANNELS } from "../shared/shared-agent-components-contract.js";
import {
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
  type SharedAgentSessionAnalytics,
  type SharedAgentSessionDetail,
  type SharedAgentSessionListResponse,
  type SharedAgentSessionsListRequest,
  type SharedAgentSessionsPageDataResponse,
  type SharedAgentSessionsQuery,
  type SharedAgentSessionUsageSummary,
} from "../shared/shared-agent-sessions-contract.js";
import {
  SHARED_BRANCHES_IPC_CHANNELS,
  type SharedBranchAnalyticsCohortRequest,
  type SharedBranchAnalyticsCohortResponse,
  type SharedBranchesDetailRequest,
  type SharedBranchesListRequest,
  type SharedBranchesPageDataResponse,
  type SharedBranchesQuery,
  type SharedBranchTraceResponse,
} from "../shared/shared-branches-contract.js";
import {
  SHARED_TRACE_COMMENTS_IPC_CHANNELS,
  type SharedTraceComment,
  type SharedTraceCommentCollectionQuery,
  type SharedTraceCommentDeleteResult,
  type SharedTraceCommentDraft,
  type SharedTraceCommentReplyDraft,
  type SharedTraceCommentTarget,
  type SharedTraceCommentUpdate,
} from "../shared/shared-trace-comments-contract.js";
import { CATALOG_CONVERT_INSTALL_CHANNEL } from "./dashboard/agent-dashboard-ipc-contract.js";
import type { CoachingInstallOutcome } from "./packs/required-plugin-installer.js";
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
const githubResyncNudgeSubscribers = new Set<
  (payload: GitHubResyncNudgeRendererEvent) => void
>();
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

ipcRenderer.on(
  "desktop:github-resync-nudge",
  (_event: unknown, payload: GitHubResyncNudgeRendererEvent) => {
    notifyGitHubResyncNudgeSubscribers(payload);
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
    // FEA-4157: combined list + usage read (mirrors `branchesApi.pageData`).
    pageData: (request?: SharedAgentSessionsListRequest) =>
      invokeLiveDb<SharedAgentSessionsPageDataResponse>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData,
        request
      ),
  },
  branchesApi: {
    list: (request?: SharedBranchesListRequest) =>
      invokeLiveDb<BranchListResponse>(
        SHARED_BRANCHES_IPC_CHANNELS.list,
        request
      ),
    detail: (request: string | SharedBranchesDetailRequest) =>
      invokeLiveDb<BranchPageDetail | null>(
        SHARED_BRANCHES_IPC_CHANNELS.detail,
        request
      ),
    trace: (id: string) =>
      invokeLiveDb<SharedBranchTraceResponse>(
        SHARED_BRANCHES_IPC_CHANNELS.trace,
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
    cohortAnalytics: (request: SharedBranchAnalyticsCohortRequest) =>
      invokeLiveDb<SharedBranchAnalyticsCohortResponse | null>(
        SHARED_BRANCHES_IPC_CHANNELS.cohortAnalytics,
        request
      ),
    pageData: (request?: SharedBranchesListRequest) =>
      invokeLiveDb<SharedBranchesPageDataResponse>(
        SHARED_BRANCHES_IPC_CHANNELS.pageData,
        request
      ),
  },
  traceCommentsApi: {
    supportsBranchTraceCommentSurfaces: true,
    list: (
      target: SharedTraceCommentTarget,
      query?: SharedTraceCommentCollectionQuery
    ) =>
      invokeLiveDb<SharedTraceComment[]>(
        SHARED_TRACE_COMMENTS_IPC_CHANNELS.list,
        target,
        query
      ),
    create: (
      target: SharedTraceCommentTarget,
      draft: SharedTraceCommentDraft,
      query?: SharedTraceCommentCollectionQuery
    ) =>
      invokeLiveDb<SharedTraceComment>(
        SHARED_TRACE_COMMENTS_IPC_CHANNELS.create,
        target,
        draft,
        query
      ),
    reply: (
      target: SharedTraceCommentTarget,
      commentId: string,
      draft: SharedTraceCommentReplyDraft,
      query?: SharedTraceCommentCollectionQuery
    ) =>
      invokeLiveDb<SharedTraceComment>(
        SHARED_TRACE_COMMENTS_IPC_CHANNELS.reply,
        target,
        commentId,
        draft,
        query
      ),
    update: (
      target: SharedTraceCommentTarget,
      commentId: string,
      update: SharedTraceCommentUpdate,
      query?: SharedTraceCommentCollectionQuery
    ) =>
      invokeLiveDb<SharedTraceComment>(
        SHARED_TRACE_COMMENTS_IPC_CHANNELS.update,
        target,
        commentId,
        update,
        query
      ),
    delete: (
      target: SharedTraceCommentTarget,
      commentId: string,
      query?: SharedTraceCommentCollectionQuery
    ) =>
      invokeLiveDb<SharedTraceCommentDeleteResult>(
        SHARED_TRACE_COMMENTS_IPC_CHANNELS.delete,
        target,
        commentId,
        query
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
    // FEA-3722: forward the selected lookback (days, or `null` = all-time) so
    // the Coding Wrap honors the top date-range selector.
    getAnalytics: (lookbackDays?: number | null) =>
      invokeLiveDb<AnalyticsData>("desktop:db:get-analytics", lookbackDays),
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
    getPlans: (opts?: DashboardListWindow) =>
      invokeLiveDb<DashboardPlanSummary[]>("desktop:db:get-plans", opts),
    getPullRequests: (opts?: DashboardListWindow) =>
      invokeLiveDb<DashboardPullRequestSummary[]>(
        "desktop:db:get-pull-requests",
        opts
      ),

    // Diagnostics (FEA-1959)
    getDiagnostics: () =>
      invokeLiveDb<DiagnosticsData>("desktop:db:get-diagnostics"),

    // Catalog (FEA-1314)
    getCatalog: () => invokeLiveDb<CatalogEntry[]>("desktop:db:get-catalog"),
    // Cloud call (not the local db-host): org-wide pack analytics via main.
    getPackAnalytics: (packId: string) =>
      invokeUnguardedChannel(
        PACK_ANALYTICS_IPC_CHANNEL,
        packId
      ) as Promise<PackAnalyticsResponse | null>,
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
    // FEA-4079: convert a component to the target harness's format and install
    // it as one gateway operation. Resolves to a ConvertInstallOutcome carrying
    // the honest boundary state (converting / partial / unsupported / error).
    catalogConvertInstall: (request: ConvertInstallRequest) =>
      invokeLiveDb<ConvertInstallOutcome>(
        CATALOG_CONVERT_INSTALL_CHANNEL,
        request
      ),
    // Opt-in coaching distribution install (FEA-2923 / §I). Unlike the catalog
    // channels this routes to a main-process handler (not the live DB runtime),
    // so it uses `ipcRenderer.invoke` directly. The handler resolves the
    // presigned asset by distribution id from the authoritative cloud response
    // and rejects on failure so the banner can surface an inline error.
    coachingInstall: (distributionId: string) =>
      invokeUnguardedChannel(
        DistributionsIpcChannel.CoachingInstall,
        distributionId
      ) as Promise<CoachingInstallOutcome>,
    // FEA-4050: durably record a decline of an opt-in distribution so the
    // reconcile does not re-surface it after an app restart. Routes to the
    // main-process handler (not the live DB runtime); resolves once persisted
    // (or immediately when not connected — the renderer already hid the row).
    declineDistribution: (distributionId: string) =>
      invokeUnguardedChannel(
        DistributionsIpcChannel.Decline,
        distributionId
      ) as Promise<void>,
    // ISS-5123: confirm with the cloud that an offer is still assigned before
    // installing it. The banner holds rows pushed by an earlier reconcile, and an
    // admin can withdraw the pack in between; rejects when the offer is gone.
    ensureDistributionAssigned: (distributionId: string) =>
      invokeUnguardedChannel(
        DistributionsIpcChannel.EnsureAssigned,
        distributionId
      ) as Promise<void>,
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

    // Optimization analytics (FEA-2923 / AC-022)
    // ISS-4403: `fingerprint` (optional, trailing) content-scopes each read to a
    // single component content version; omitted → name-level (pre-ISS-4403).
    getComponentModelTrend: (
      componentKind: string,
      componentKey: string,
      model?: string,
      days?: number,
      fingerprint?: string
    ) =>
      invokeLiveDb<ComponentModelTrendResponse>(
        "desktop:db:get-component-model-trend",
        componentKind,
        componentKey,
        model,
        days,
        fingerprint
      ),
    getSubagentFrequency: (
      subagentKey: string,
      days?: number,
      fingerprint?: string
    ) =>
      invokeLiveDb<SubagentFrequencyResponse>(
        "desktop:db:get-subagent-frequency",
        subagentKey,
        days,
        fingerprint
      ),
    isSkillLoaded: (skillKey: string, fingerprint?: string) =>
      invokeLiveDb<SkillLoadedResponse>(
        "desktop:db:is-skill-loaded",
        skillKey,
        fingerprint
      ),

    // Agent components local read (FEA-2923 / T-16.3)
    listAgentComponents: (filters: AgentComponentQueryFilters) =>
      invokeLiveDb<AgentComponentListResponse>(
        SHARED_AGENT_COMPONENTS_IPC_CHANNELS.list,
        filters
      ),
    getAgentComponentDetail: (slug: string) =>
      invokeLiveDb<AgentComponentDetail | null>(
        SHARED_AGENT_COMPONENTS_IPC_CHANNELS.detail,
        slug
      ),
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
  /** Subscribe to server-origin GitHub resync nudges delivered through Desktop. */
  onGitHubResyncNudge: (
    callback: (payload: GitHubResyncNudgeRendererEvent) => void
  ) => {
    githubResyncNudgeSubscribers.add(callback);
    return () => {
      githubResyncNudgeSubscribers.delete(callback);
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
  /**
   * Subscribe to opt-in distributions pushed by the main-process
   * `RequiredPluginInstaller` (FEA-2923 / §I). Mirrors `onInstallOutput`.
   */
  onDistributionsOptInAvailable: (
    callback: (distributions: OptInDistributionDto[]) => void
  ) => {
    const handler = (_event: unknown, distributions: OptInDistributionDto[]) =>
      callback(distributions);
    ipcRenderer.on("desktop:distributions:opt-in-available", handler);
    return () =>
      ipcRenderer.removeListener(
        "desktop:distributions:opt-in-available",
        handler
      );
  },
};

exposeDesktopApi(designSystemDashboardApi);

function notifyDbChangeSubscribers(payload: DbChangePayload): void {
  for (const callback of dbChangeSubscribers) {
    callback(payload);
  }
}

function notifyGitHubResyncNudgeSubscribers(
  payload: GitHubResyncNudgeRendererEvent
): void {
  for (const callback of githubResyncNudgeSubscribers) {
    callback(payload);
  }
}

/**
 * ISS-5262 — the shutdown sentinel a `desktop:db:*` handler resolves with when
 * the db-host went away mid-read stops HERE. The renderer keeps the exact
 * contract it had before: a read that raced the teardown rejects, as it always
 * did. What changed is only that the rejection is now minted in the renderer
 * process instead of in `ipcMain.handle`, so the main-process log no longer
 * prints a handler error after `shutdown sequence end: clean`.
 *
 * Rejecting is also the only honest option: the read never ran, so there is no
 * value to hand a caller. Resolving the sentinel through would let a summary
 * card render a fabricated `0`, and resolving `null` would read as "no data"
 * rather than "unknown". The rejection message carries a transient db-host
 * signature so the renderer classifies it exactly as it classified the old
 * `db-host exited (code: 0)` — see `DB_HOST_SHUTTING_DOWN_MESSAGE`.
 */
function invokeLiveDb<TResult>(
  channel: DbGuardedChannel,
  ...args: unknown[]
): Promise<TResult> {
  liveDbInFlightCount += 1;
  // The ONE sanctioned widening of a guarded channel back to `string` in this
  // module — this helper IS the guarded path, and the `.then` below is what
  // `invokeUnguardedChannel`'s `NotDbGuarded` constraint exists to force.
  const rawChannel: string = channel;
  return (ipcRenderer.invoke(rawChannel, ...args) as Promise<TResult>)
    .then(rejectIfDbHostShuttingDown)
    .finally(() => {
      liveDbInFlightCount = Math.max(0, liveDbInFlightCount - 1);
      if (liveDbReady && liveDbInFlightCount === 0) {
        scheduleRendererLiveDbIdleNotification();
      }
    });
}

/**
 * ISS-5262 — invoke a channel that is NOT registered through `withDb`.
 *
 * `NotDbGuarded` collapses the parameter to `never` for any `withDb`-backed
 * namespace, so a bridge that reaches for a db channel here (and therefore
 * skips {@link rejectIfDbHostShuttingDown}) fails to COMPILE instead of shipping
 * the payload-free shutdown sentinel to a caller expecting data. Guarded
 * channels go through {@link invokeLiveDb}.
 */
function invokeUnguardedChannel<TChannel extends string>(
  channel: TChannel & NotDbGuarded<TChannel>,
  ...args: unknown[]
): Promise<unknown> {
  return ipcRenderer.invoke(channel, ...args);
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
