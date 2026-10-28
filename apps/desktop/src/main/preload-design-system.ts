import type {
  AgentComponentDetail,
  AgentComponentFrequency,
  AgentComponentListResponse,
  AgentComponentQueryFilters,
  ComponentModelTrendResponse,
  SkillLoadedResponse,
  SubagentFrequencyResponse,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentVersionUsageResponse } from "@repo/api/src/types/agent-component-version-usage";
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
import type {
  AgentComponentPageDataRequest,
  AgentComponentPageDataResult,
} from "@repo/api/src/utils/agent-component-page-data";
import { ipcRenderer } from "electron";
import type { GitHubResyncNudgeRendererEvent } from "../renderer/types/desktop-api.js";
import { AgentDashboardDbIpcChannel } from "../shared/agent-dashboard-db-ipc-channel.js";
import type {
  AgentHierarchyNode,
  AgentRow,
  AnalyticsData,
  CatalogContentItem,
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
import { DesktopRendererEventChannel } from "../shared/desktop-renderer-event-channel.js";
import type {
  DiagnosticsData,
  DiagnosticsRequest,
} from "../shared/diagnostics-contract.js";
import { DistributionsIpcChannel } from "../shared/distributions-channel.js";
import {
  LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
  LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
  type LocalPriorityWriteRequest,
  type LocalPriorityWriteResult,
} from "../shared/local-priority-write-contract.js";
import { PACK_ANALYTICS_IPC_CHANNEL } from "../shared/pack-analytics-channel.js";
import { rejectIfReadCancelled } from "../shared/read-cancellation-contract.js";
import type { SharedAgentSessionReadOptions } from "../shared/read-initiator-contract.js";
import { RendererLifecycleIpcChannel } from "../shared/renderer-lifecycle-ipc-channel.js";
import { SHARED_AGENT_COMPONENTS_IPC_CHANNELS } from "../shared/shared-agent-components-contract.js";
import {
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
  type SharedAgentSessionAnalytics,
  type SharedAgentSessionDetail,
  type SharedAgentSessionEventsPage,
  type SharedAgentSessionEventsPageRequest,
  type SharedAgentSessionInvocationTreePage,
  type SharedAgentSessionInvocationTreeRequest,
  type SharedAgentSessionListResponse,
  type SharedAgentSessionsCancelReadResult,
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
  THREAD_VIEWED_CHANNEL,
  type ThreadViewedResult,
} from "../shared/thread-viewership-contract.js";
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

ipcRenderer.on(DesktopRendererEventChannel.DbReady, () => {
  liveDbReady = true;
  notifyDbChangeSubscribers({});
});

ipcRenderer.on(
  DesktopRendererEventChannel.DbChanged,
  (_event: unknown, payload: DbChangePayload = {}) => {
    notifyDbChangeSubscribers(payload);
  }
);

ipcRenderer.on(
  DesktopRendererEventChannel.GithubResyncNudge,
  (_event: unknown, payload: GitHubResyncNudgeRendererEvent) => {
    notifyGitHubResyncNudgeSubscribers(payload);
  }
);

const designSystemDashboardApi = {
  agentSessionsApi: {
    componentScopeVersion: 1,
    list: (request?: SharedAgentSessionsListRequest) =>
      invokeLiveDb<SharedAgentSessionListResponse>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.list,
        request
      ),
    detail: (id: string, options?: SharedAgentSessionReadOptions) =>
      invokeLiveDb<SharedAgentSessionDetail | null>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail,
        id,
        ...(options === undefined ? [] : [options])
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
    // ISS-9857: a keyset page of raw events past the detail's bounded prefix.
    eventsPage: (request: SharedAgentSessionEventsPageRequest) =>
      invokeLiveDb<SharedAgentSessionEventsPage | null>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.events,
        request
      ),
    // ISS-10737: the session's whole invocation tree for the Trace tab.
    invocationTree: (request: SharedAgentSessionInvocationTreeRequest) =>
      invokeLiveDb<SharedAgentSessionInvocationTreePage | null>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.invocationTree,
        request
      ),
    // ISS-9802: the abort, as something that can cross the bridge. The token
    // rides the SAME `cancellationToken` field the reads carry it in, so main
    // reads it back with one helper on both channels. It takes its argument
    // without destructuring or validating it, so it still names its channel when
    // called with nothing — which the preload↔handler parity derivation does —
    // and a token main cannot use is answered `requested: false`.
    cancelRead: (token?: string) =>
      invokeLiveDb<SharedAgentSessionsCancelReadResult>(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.cancelRead,
        { cancellationToken: token }
      ),
    // ISS-10332: the local-mode priority write.
    updatePriority: (request: LocalPriorityWriteRequest) =>
      invokeLiveDb<LocalPriorityWriteResult>(
        LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
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
    // ISS-10332: the local-mode priority write.
    updatePriority: (request: LocalPriorityWriteRequest) =>
      invokeLiveDb<LocalPriorityWriteResult>(
        LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
        request
      ),
  },
  db: {
    getSessions: () =>
      invokeLiveDb<SessionRow[]>(AgentDashboardDbIpcChannel.GetSessions),
    getSession: (id: string) =>
      invokeLiveDb<SessionRow | undefined>(
        AgentDashboardDbIpcChannel.GetSession,
        id
      ),
    getSessionDetails: (id: string) =>
      invokeLiveDb<SessionWithAgents | undefined>(
        AgentDashboardDbIpcChannel.GetSessionDetails,
        id
      ),
    // ISS-7830: record that the user navigated INTO this thread. Separate from
    // `getSessionDetails` on purpose — a detail read can be a prefetch or a poll
    // tick, and only an explicit statement from the view that mounted is evidence
    // a person opened it.
    markSessionViewed: (id: string) =>
      invokeLiveDb<ThreadViewedResult>(THREAD_VIEWED_CHANNEL, id),
    getAgents: (sessionId: string) =>
      invokeLiveDb<AgentRow[]>(AgentDashboardDbIpcChannel.GetAgents, sessionId),
    getEvents: (sessionId: string, agentId?: string) =>
      invokeLiveDb<EventRow[]>(
        AgentDashboardDbIpcChannel.GetEvents,
        sessionId,
        agentId
      ),
    getDashboardSummary: () =>
      invokeLiveDb<DashboardSummary>(
        AgentDashboardDbIpcChannel.GetDashboardSummary
      ),
    getInsights: (section: string, period: string, scope?: string) =>
      invokeLiveDb(
        AgentDashboardDbIpcChannel.GetInsights,
        section,
        period,
        scope
      ),
    getSessionsWithDetails: () =>
      invokeLiveDb<SessionWithAgents[]>(
        AgentDashboardDbIpcChannel.GetSessionsWithDetails
      ),
    getSessionsPage: (request?: SessionPageRequest) =>
      invokeLiveDb<SessionPage>(
        AgentDashboardDbIpcChannel.GetSessionsPage,
        request
      ),
    getKanbanPages: (statuses: string[], limit: number) =>
      invokeLiveDb<KanbanPages>(
        AgentDashboardDbIpcChannel.GetKanbanPages,
        statuses,
        limit
      ),
    getEventFeed: () =>
      invokeLiveDb<EventWithSession[]>(AgentDashboardDbIpcChannel.GetEventFeed),
    getEventsWithSession: (sessionId: string) =>
      invokeLiveDb<EventWithSession[]>(
        AgentDashboardDbIpcChannel.GetEventsWithSession,
        sessionId
      ),
    getEventCountByType: () =>
      invokeLiveDb<EventCountByType[]>(
        AgentDashboardDbIpcChannel.GetEventCountByType
      ),
    getTokenAnalytics: () =>
      invokeLiveDb<TokenAnalytics>(
        AgentDashboardDbIpcChannel.GetTokenAnalytics
      ),
    getAgentHierarchy: (sessionId: string) =>
      invokeLiveDb<AgentHierarchyNode[]>(
        AgentDashboardDbIpcChannel.GetAgentHierarchy,
        sessionId
      ),
    // FEA-3722: forward the selected lookback (days, or `null` = all-time) so
    // the Coding Wrap honors the top date-range selector.
    getAnalytics: (lookbackDays?: number | null) =>
      invokeLiveDb<AnalyticsData>(
        AgentDashboardDbIpcChannel.GetAnalytics,
        lookbackDays
      ),
    getWorkflowData: () =>
      invokeLiveDb<WorkflowQueryData>(
        AgentDashboardDbIpcChannel.GetWorkflowData
      ),
    getCoreFeatures: () =>
      invokeLiveDb<DashboardCoreFeatures>(
        AgentDashboardDbIpcChannel.GetCoreFeatures
      ),
    getPacks: () =>
      invokeLiveDb<DashboardPackSummary[]>(AgentDashboardDbIpcChannel.GetPacks),
    getSkills: () =>
      invokeLiveDb<DashboardSkillSummary[]>(
        AgentDashboardDbIpcChannel.GetSkills
      ),
    getTools: () =>
      invokeLiveDb<DashboardToolSummary[]>(AgentDashboardDbIpcChannel.GetTools),
    getSubAgents: () =>
      invokeLiveDb<DashboardSubAgentSummary[]>(
        AgentDashboardDbIpcChannel.GetSubagents
      ),
    getPlans: (opts?: DashboardListWindow) =>
      invokeLiveDb<DashboardPlanSummary[]>(
        AgentDashboardDbIpcChannel.GetPlans,
        opts
      ),
    getPullRequests: (opts?: DashboardListWindow) =>
      invokeLiveDb<DashboardPullRequestSummary[]>(
        AgentDashboardDbIpcChannel.GetPullRequests,
        opts
      ),

    // Diagnostics (FEA-1959)
    getDiagnostics: (request?: DiagnosticsRequest) =>
      invokeLiveDb<DiagnosticsData>(
        AgentDashboardDbIpcChannel.GetDiagnostics,
        request
      ),

    // Catalog (FEA-1314)
    getCatalog: () =>
      invokeLiveDb<CatalogEntry[]>(AgentDashboardDbIpcChannel.GetCatalog),
    // Cloud call (not the local db-host): org-wide pack analytics via main.
    getPackAnalytics: (packId: string) =>
      invokeUnguardedChannel(
        PACK_ANALYTICS_IPC_CHANNEL,
        packId
      ) as Promise<PackAnalyticsResponse | null>,
    getCatalogEntry: (packId: string) =>
      invokeLiveDb<CatalogEntry | null>(
        AgentDashboardDbIpcChannel.GetCatalogEntry,
        packId
      ),
    getCatalogContents: (packId: string) =>
      invokeLiveDb<CatalogContentItem[] | null>(
        AgentDashboardDbIpcChannel.GetCatalogContents,
        packId
      ),
    getCatalogHistory: (packId: string) =>
      invokeLiveDb<Array<{ fetchedAt: string; stars: number; forks: number }>>(
        AgentDashboardDbIpcChannel.GetCatalogHistory,
        packId
      ),
    catalogInstall: (packId: string, harness: string, cwd?: string) =>
      invokeLiveDb<CatalogMutationResult>(
        AgentDashboardDbIpcChannel.CatalogInstall,
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
    acknowledgeDistributionHandled: (distributionId: string) =>
      invokeUnguardedChannel(
        DistributionsIpcChannel.Handled,
        distributionId
      ) as Promise<void>,
    catalogUninstall: (packId: string, harness: string, cwd?: string) =>
      invokeLiveDb<CatalogMutationResult>(
        AgentDashboardDbIpcChannel.CatalogUninstall,
        packId,
        harness,
        cwd
      ),
    catalogRefresh: () =>
      invokeLiveDb<void>(AgentDashboardDbIpcChannel.CatalogRefresh),
    getInstallRuns: (packId?: string) =>
      invokeLiveDb<InstallRunRecord[]>(
        AgentDashboardDbIpcChannel.GetInstallRuns,
        packId
      ),

    // Installed packs (FEA-1224)
    getInstalledPacks: () =>
      invokeLiveDb<InstalledPack[]>(
        AgentDashboardDbIpcChannel.GetInstalledPacks
      ),
    getPackDetail: (packId: string) =>
      invokeLiveDb<InstalledPackDetail | null>(
        AgentDashboardDbIpcChannel.GetPackDetail,
        packId
      ),
    getPackSessions: (packId: string) =>
      invokeLiveDb<unknown[]>(
        AgentDashboardDbIpcChannel.GetPackSessions,
        packId
      ),
    getAllSkills: () =>
      invokeLiveDb<SkillWithInvocations[]>(
        AgentDashboardDbIpcChannel.GetAllSkills
      ),
    getSkillInvocations: (name: string) =>
      invokeLiveDb<SkillInvocation[]>(
        AgentDashboardDbIpcChannel.GetSkillInvocations,
        name
      ),

    // Plans (FEA-1189)
    getPlansList: (opts?: {
      sessionId?: string;
      needsConfirmation?: boolean;
      limit?: number;
      offset?: number;
    }) =>
      invokeLiveDb<PlanRecord[]>(AgentDashboardDbIpcChannel.GetPlansList, opts),
    getPlan: (id: string) =>
      invokeLiveDb<PlanRecord | null>(AgentDashboardDbIpcChannel.GetPlan, id),
    getPlanVersions: (planId: string) =>
      invokeLiveDb<PlanVersionRecord[]>(
        AgentDashboardDbIpcChannel.GetPlanVersions,
        planId
      ),
    confirmPlan: (id: string) =>
      invokeLiveDb<void>(AgentDashboardDbIpcChannel.ConfirmPlan, id),
    rejectPlan: (id: string) =>
      invokeLiveDb<void>(AgentDashboardDbIpcChannel.RejectPlan, id),
    openPlan: (id: string, target?: string) =>
      invokeLiveDb<void>(AgentDashboardDbIpcChannel.OpenPlan, id, target),

    // Pull Requests (FEA-1226)
    getPrStats: () =>
      invokeLiveDb<PrStats>(AgentDashboardDbIpcChannel.GetPrStats),
    getPrSessions: (opts?: { limit?: number; offset?: number }) =>
      invokeLiveDb<PrSessionGroup[]>(
        AgentDashboardDbIpcChannel.GetPrSessions,
        opts
      ),
    getPrList: (opts?: {
      sessionId?: string;
      repo?: string;
      limit?: number;
      offset?: number;
    }) => invokeLiveDb<PrRecord[]>(AgentDashboardDbIpcChannel.GetPrList, opts),
    openPr: (id: string) =>
      invokeLiveDb<void>(AgentDashboardDbIpcChannel.OpenPr, id),

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
        AgentDashboardDbIpcChannel.GetComponentModelTrend,
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
        AgentDashboardDbIpcChannel.GetSubagentFrequency,
        subagentKey,
        days,
        fingerprint
      ),
    isSkillLoaded: (skillKey: string, fingerprint?: string) =>
      invokeLiveDb<SkillLoadedResponse>(
        AgentDashboardDbIpcChannel.IsSkillLoaded,
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
    getAgentComponentFrequency: (slug: string, windowDays: number) =>
      invokeLiveDb<AgentComponentFrequency | null>(
        SHARED_AGENT_COMPONENTS_IPC_CHANNELS.frequency,
        slug,
        windowDays
      ),
    // ISS-6822: the bounded page-data read. Additive beside `listAgentComponents`
    // — a renderer that does not use it is unaffected, and the shared Agents list
    // falls back to `list` when this method is absent.
    getAgentComponentsPageData: (request: AgentComponentPageDataRequest) =>
      invokeLiveDb<AgentComponentPageDataResult>(
        SHARED_AGENT_COMPONENTS_IPC_CHANNELS.pageData,
        request
      ),
    // ISS-10467/ISS-10468: the per-content-version usage drill-down. Additive
    // beside the detail read; a renderer on an older preload simply finds no
    // method and its data source omits the capability.
    getAgentComponentVersionUsage: (
      slug: string,
      versionHashes: readonly string[]
    ) =>
      invokeLiveDb<AgentComponentVersionUsageResponse | null>(
        SHARED_AGENT_COMPONENTS_IPC_CHANNELS.versionUsage,
        slug,
        // `?? []` rather than a bare spread: a preload bridge must NAME its
        // channel before it can throw. Spreading an absent argument threw inside
        // the bridge, which left this channel out of the derived preload set
        // entirely and made it look like a handler no bridge reaches — an
        // unroutable live IPC channel, as far as the parity guard could tell.
        [...(versionHashes ?? [])]
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
    ipcRenderer.on(DesktopRendererEventChannel.PackInstallOutput, handler);
    return () =>
      ipcRenderer.removeListener(
        DesktopRendererEventChannel.PackInstallOutput,
        handler
      );
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
    ipcRenderer.on(
      DesktopRendererEventChannel.DistributionsOptInAvailable,
      handler
    );
    return () =>
      ipcRenderer.removeListener(
        DesktopRendererEventChannel.DistributionsOptInAvailable,
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
  return (
    (ipcRenderer.invoke(rawChannel, ...args) as Promise<TResult>)
      .then(rejectIfDbHostShuttingDown)
      // ISS-9802: the cancellation sentinel is the second payload-free answer a
      // `withDb` channel can resolve, and it needs the same unwrap — a sentinel
      // that slipped past would typecheck as `T` and reach the renderer as data.
      .then(rejectIfReadCancelled)
      .finally(() => {
        liveDbInFlightCount = Math.max(0, liveDbInFlightCount - 1);
        if (liveDbReady && liveDbInFlightCount === 0) {
          scheduleRendererLiveDbIdleNotification();
        }
      })
  );
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
    ipcRenderer.send(RendererLifecycleIpcChannel.RendererLiveDbIdle);
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
    ipcRenderer.send(RendererLifecycleIpcChannel.RendererUserInput);
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
