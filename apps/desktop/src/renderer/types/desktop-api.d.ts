import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsSection,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import type {
  AgentComponentDetail,
  AgentComponentListResponse,
  AgentComponentQueryFilters,
  ComponentModelTrendResponse,
  SkillLoadedResponse,
  SubagentFrequencyResponse,
} from "@repo/api/src/types/agent-component";
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchUsageSummary,
  MergedTraceItem,
} from "@repo/api/src/types/branch";
import type {
  TraceComment,
  TraceCommentDeleteResult,
  TraceCommentDraft,
  TraceCommentReplyDraft,
  TraceCommentTarget,
  TraceCommentUpdate,
} from "@repo/api/src/types/comment";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import type { OptInDistributionDto } from "@repo/api/src/types/distribution";
import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import type { GitHubResyncNudgeBody } from "@repo/api/src/types/github-dirty-scope-constants";
import type {
  RelayHttpRequestPayload,
  RelayResponseEnvelope,
} from "@repo/shared-platform/relay-request-model";
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
} from "../../shared/agent-db-contract";
import type { CoachingPackInfo } from "../../shared/coaching-pack-contract";
import type {
  AgentMonitorHooksResult,
  DesktopAuthState,
  DesktopBrowserSignInResult,
  SaveConfigPayload,
} from "../../shared/contracts";
import type { DiagnosticsData } from "../../shared/diagnostics-contract";
import type { LocalSessionSourceStatus } from "../../shared/local-session-source-status";
import type {
  RendererOtelBridgePayload,
  RendererOtelExportResult,
} from "../../shared/renderer-otel-bridge-constants";
import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionsQuery,
} from "../../shared/shared-agent-sessions-contract";
import type {
  SharedBranchesDetailRequest,
  SharedBranchesListRequest,
  SharedBranchesQuery,
} from "../../shared/shared-branches-contract";

export type GitHubResyncNudgeRendererEvent = {
  body: GitHubResyncNudgeBody | unknown;
  branchIds?: readonly string[];
};

export type AgentMonitorUrl = {
  url: string | null;
  ready: boolean;
  enabled: boolean;
  planExtractionEnabled: boolean;
  localSessionSourceStatus: LocalSessionSourceStatus;
};

export type SandboxInspectResult = {
  path: string;
  isGitRepo: boolean;
  suggestedPath: string | undefined;
};

/**
 * Success result of `db.coachingInstall(distributionId)` (FEA-2923 / §I).
 * Mirrors the successful arm of the main-process `CoachingInstallOutcome`
 * (`packs/required-plugin-installer.ts`): the handler REJECTS on every failure
 * arm (not found / wrong type / feature-flag off / download-extract-validate
 * failure), so the renderer only ever resolves with `installed` (pack
 * copied/activated) or `skipped` (override precedence honored a recorded user
 * choice — nothing changed). Declared renderer-locally rather than imported
 * from the main-process module to avoid a renderer→main type dependency.
 */
export type CoachingDistributionInstallResult = {
  status: "installed" | "skipped";
  installedVersion?: string | null;
};

export type AgentMonitorHookResult = AgentMonitorHooksResult;

export type DesktopFeatureFlagState = {
  key: string;
  value: boolean;
  source: "env" | "user" | "default";
};

export type GitHubConnectOpenResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: "untrusted_sender" | "invalid_origin" | "open_failed";
    };

export type GitHubConnectOpenRequest = {
  install?: boolean;
  returnTo?: string;
};

// Re-exported for the renderer surfaces (e.g. the Account tab) that read the
// signed-in identity shape from the desktop-api module.
export type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
// First-party auth wire contract (FEA-2219). Sourced from the shared
// `contracts.ts` module rather than re-declared, so the renderer stays in
// lockstep with the main-process definitions — including the closed
// `DesktopBrowserSignInFailure` reason set — and re-exported here for the
// renderer surfaces that import these types from the desktop-api module.
export type {
  DesktopAuthState,
  DesktopAuthStatus,
  DesktopBrowserSignInFailure,
  DesktopBrowserSignInResult,
} from "../../shared/contracts";

export type DesktopApi = {
  /**
   * Host platform (`process.platform`), exposed statically by the preload.
   * Spelled as a literal union because the renderer program excludes Node types
   * (`"types": []` in tsconfig.renderer.json), so `NodeJS.Platform` is unavailable.
   */
  platform:
    | "aix"
    | "android"
    | "darwin"
    | "freebsd"
    | "haiku"
    | "linux"
    | "openbsd"
    | "sunos"
    | "win32"
    | "cygwin"
    | "netbsd";
  /**
   * Major macOS product version (15 = Sequoia, 26 = Tahoe), or null off macOS /
   * when it can't be read. Used to gate the stoplight underlay to the pre-Tahoe
   * versions that drop the native buttons on blur.
   */
  macOSMajorVersion: number | null;
  getSettings: () => Promise<unknown>;
  updateSettings: (partial: unknown) => Promise<unknown>;
  getRuntimeStatus: () => Promise<unknown>;
  listCommandSigningKeys: () => Promise<unknown>;
  listAuthorizedKeys: () => Promise<unknown>;
  authorizeKey: (payload: unknown) => Promise<unknown>;
  removeAuthorizedKey: (fingerprint: string) => Promise<unknown>;
  listOrgPublicKeys: () => Promise<unknown>;
  approveOrgPublicKey: (fingerprint: string) => Promise<unknown>;
  rejectOrgPublicKey: (fingerprint: string) => Promise<unknown>;
  authorizeCommandSigningKey: (fingerprint: string) => Promise<unknown>;
  revokeCommandSigningKey: (fingerprint: string) => Promise<unknown>;
  getActivityEvents: () => Promise<unknown>;
  clearActivityEvents: () => Promise<unknown>;
  getPendingApprovals: () => Promise<unknown>;
  approveApproval: (approvalId: string) => Promise<unknown>;
  denyApproval: (approvalId: string) => Promise<unknown>;
  alwaysAllowApproval: (approvalId: string) => Promise<unknown>;
  clearPendingApprovals: () => Promise<unknown>;
  getResolvedApprovals: () => Promise<unknown>;
  clearResolvedApprovals: () => Promise<unknown>;
  getApiKeyStatus: () => Promise<unknown>;
  setApiKey: (apiKey: string) => Promise<unknown>;
  clearApiKey: () => Promise<unknown>;
  getCloudCommandsPaused: () => Promise<unknown>;
  setCloudCommandsPaused: (paused: boolean) => Promise<unknown>;
  getCloudConnectionEnabled: () => Promise<unknown>;
  setCloudConnectionEnabled: (enabled: boolean) => Promise<unknown>;
  getOnboardingState: () => Promise<unknown>;
  completeOnboarding: (payload: unknown) => Promise<unknown>;
  startDeviceOnboarding: (payload: unknown) => Promise<unknown>;
  dismissOnboardingPopup: (payload: { permanent: boolean }) => Promise<unknown>;
  onboardingPopupCta: () => Promise<unknown>;
  pickSandboxDirectory: () => Promise<SandboxInspectResult | null>;
  inspectSandboxPath: (path: string) => Promise<SandboxInspectResult | null>;
  getDangerousAutoApprove: () => Promise<boolean>;
  setDangerousAutoApprove: (enabled: boolean) => Promise<boolean>;
  removeAlwaysAllowRule: (ruleId: string) => Promise<unknown>;
  checkForUpdate: () => Promise<unknown>;
  applyUpdate: () => Promise<unknown>;
  moveToApplications: () => Promise<boolean>;
  isDebugAuthEnabled: () => Promise<boolean>;
  mintDebugToken: (origin?: string) => Promise<unknown>;
  listRunningJobs: () => Promise<unknown>;
  listCompletedJobs: () => Promise<unknown>;
  getJob: (jobId: string) => Promise<unknown>;
  getJobLogTail: (jobId: string, lines?: number) => Promise<unknown>;
  getLogs: () => Promise<unknown>;
  clearLogs: () => Promise<unknown>;
  getLogFilePath: () => Promise<string>;
  openLogFile: () => Promise<unknown>;
  getAppVersion: () => Promise<string>;
  getBinaryPaths: () => Promise<unknown>;
  patchBinaryPaths: (patch: unknown) => Promise<unknown>;
  detectCliTools: () => Promise<unknown>;
  /** Notify main that the desktop renderer has nonblank shell content to show. */
  notifyRendererReady: () => void;
  /**
   * Engineer gateway transport (M-001): dispatch an `/api/gateway/*` request to
   * the trusted main process, which validates + loops back to the local gateway.
   */
  dispatchGateway: (
    payload: RelayHttpRequestPayload
  ) => Promise<RelayResponseEnvelope>;
  exportOtelTelemetry?: (
    payload: RendererOtelBridgePayload
  ) => Promise<RendererOtelExportResult>;
  saveConfig: (payload: string | SaveConfigPayload) => Promise<unknown>;
  findMatchingConfig: () => Promise<unknown>;
  listConfigs: () => Promise<unknown>;
  deleteConfig: (id: string) => Promise<unknown>;
  renameConfig: (id: string, name: string) => Promise<unknown>;
  applyConfig: (id: string) => Promise<unknown>;
  getAgentMonitorUrl: () => Promise<AgentMonitorUrl>;
  openAgentMonitor: () => Promise<unknown>;
  getAgentMonitorHooksEnabled: () => Promise<boolean>;
  setAgentMonitorHooksEnabled: (
    enabled: boolean
  ) => Promise<AgentMonitorHookResult>;
  setAgentMonitorImportPaused: (paused: boolean) => Promise<void>;
  getAllFlags: () => Promise<{ flags: DesktopFeatureFlagState[] }>;
  onFlagsChanged?: (callback: () => void) => void;
  /** Run the rendered coaching prompt through the local `claude -p` harness. */
  generateCoachingTips: (prompt: string) => Promise<string>;
  /** Install a reviewed coaching artifact via the chosen local harness. */
  installCoachingArtifact: (draft: string, harness?: string) => Promise<string>;
  /**
   * The active coaching pack whose signals override the built-in coaching
   * best-practice signals, or null when the built-in defaults are in effect.
   */
  getCoachingPack: () => Promise<CoachingPackInfo | null>;
  /**
   * Install an external coaching-pack folder into the managed store and make it
   * active (the pack "distribution method"). Returns the installed pack info.
   */
  installCoachingPack: (sourceDir: string) => Promise<CoachingPackInfo>;
  /** @deprecated Replaced by in-process dashboard database */
  getAgentMonitorData?: (query: string) => Promise<unknown>;
  /** Local shared Agent Sessions API adapter exposed by the design-system preload. */
  agentSessionsApi: {
    list: (
      request?: SharedAgentSessionsListRequest
    ) => Promise<AgentSessionListResponse>;
    detail: (id: string) => Promise<AgentSessionDetail | null>;
    usage: (
      request?: SharedAgentSessionsQuery
    ) => Promise<AgentSessionUsageSummary>;
    analytics: (
      request?: SharedAgentSessionsQuery
    ) => Promise<AgentSessionAnalytics>;
  };
  /** Local shared Branches API adapter exposed by the design-system preload. */
  branchesApi: {
    list: (request?: SharedBranchesListRequest) => Promise<BranchListResponse>;
    detail: (
      request: string | SharedBranchesDetailRequest
    ) => Promise<BranchPageDetail | null>;
    /** PLN-1148 Phase 2: lazy events-heavy merged trace for the timeline tab. */
    trace: (id: string) => Promise<MergedTraceItem[]>;
    usage: (request?: SharedBranchesQuery) => Promise<BranchUsageSummary>;
    analytics: (request?: SharedBranchesQuery) => Promise<BranchAnalytics>;
  };
  /** Cloud-backed trace comments exposed through main-process IPC. */
  traceCommentsApi: {
    list: (target: TraceCommentTarget) => Promise<TraceComment[]>;
    create: (
      target: TraceCommentTarget,
      draft: TraceCommentDraft
    ) => Promise<TraceComment>;
    reply: (
      target: TraceCommentTarget,
      commentId: string,
      draft: TraceCommentReplyDraft
    ) => Promise<TraceComment>;
    update: (
      target: TraceCommentTarget,
      commentId: string,
      update: TraceCommentUpdate
    ) => Promise<TraceComment>;
    delete: (
      target: TraceCommentTarget,
      commentId: string
    ) => Promise<TraceCommentDeleteResult>;
  };
  /** Database IPC channels (typed against the in-process repository shapes). */
  db: {
    getSessions: () => Promise<SessionRow[]>;
    getSession: (id: string) => Promise<SessionRow | undefined>;
    getSessionDetails: (id: string) => Promise<SessionWithAgents | undefined>;
    getAgents: (sessionId: string) => Promise<AgentRow[]>;
    getEvents: (sessionId: string, agentId?: string) => Promise<EventRow[]>;
    getDashboardSummary: () => Promise<DashboardSummary>;
    getSessionsWithDetails: () => Promise<SessionWithAgents[]>;
    getSessionsPage: (request?: SessionPageRequest) => Promise<SessionPage>;
    getKanbanPages: (statuses: string[], limit: number) => Promise<KanbanPages>;
    getEventFeed: () => Promise<EventWithSession[]>;
    getEventsWithSession: (sessionId: string) => Promise<EventWithSession[]>;
    getEventCountByType: () => Promise<EventCountByType[]>;
    getTokenAnalytics: () => Promise<TokenAnalytics>;
    getInsights: (
      section: InsightsSection,
      period: InsightsPeriod,
      scope?: InsightsScope
    ) => Promise<
      | DeliveryInsightsResponse
      | UtilizationInsightsResponse
      | AgentsInsightsResponse
    >;
    getAgentHierarchy: (sessionId: string) => Promise<AgentHierarchyNode[]>;
    getAnalytics: () => Promise<AnalyticsData>;
    getWorkflowData: () => Promise<WorkflowQueryData>;
    getCoreFeatures: () => Promise<DashboardCoreFeatures>;
    getPacks: () => Promise<DashboardPackSummary[]>;
    getSkills: () => Promise<DashboardSkillSummary[]>;
    getTools: () => Promise<DashboardToolSummary[]>;
    getSubAgents: () => Promise<DashboardSubAgentSummary[]>;
    getPlans: () => Promise<DashboardPlanSummary[]>;
    getPullRequests: () => Promise<DashboardPullRequestSummary[]>;

    // Catalog (FEA-1314)
    getCatalog: () => Promise<CatalogEntry[]>;
    /** Cloud: org-wide analytics for a pack (desktop-team overlay). */
    getPackAnalytics: (packId: string) => Promise<PackAnalyticsResponse | null>;
    getCatalogEntry: (packId: string) => Promise<CatalogEntry | null>;
    getCatalogReadme: (packId: string) => Promise<string | null>;
    getCatalogContents: (packId: string) => Promise<unknown[] | null>;
    getCatalogHistory: (
      packId: string
    ) => Promise<Array<{ fetchedAt: string; stars: number; forks: number }>>;
    catalogInstall: (
      packId: string,
      harness: string,
      cwd?: string
    ) => Promise<CatalogMutationResult>;
    /**
     * Install an opt-in coaching-pack distribution by distribution id
     * (FEA-2923 / §I). Routes to the main-process coaching installer, which
     * resolves the presigned asset from the authoritative cloud response and
     * copies/activates the pack honoring override precedence. Rejects on any
     * non-installed outcome (not found, wrong type, feature-flag off, or
     * download/extract/validate failure) so the opt-in banner can surface an
     * inline error and keep the row visible.
     */
    coachingInstall: (
      distributionId: string
    ) => Promise<CoachingDistributionInstallResult>;
    catalogUninstall: (
      packId: string,
      harness: string,
      cwd?: string
    ) => Promise<CatalogMutationResult>;
    catalogRefresh: () => Promise<void>;
    getInstallRuns: (packId?: string) => Promise<InstallRunRecord[]>;

    // Installed packs (FEA-1224)
    getInstalledPacks: () => Promise<InstalledPack[]>;
    getPackDetail: (packId: string) => Promise<InstalledPackDetail | null>;
    getPackSessions: (packId: string) => Promise<unknown[]>;
    getAllSkills: () => Promise<SkillWithInvocations[]>;
    getSkillInvocations: (name: string) => Promise<SkillInvocation[]>;
    getRecentProjects: () => Promise<string[]>;

    // Plans (FEA-1189)
    getPlansList: (opts?: {
      sessionId?: string;
      needsConfirmation?: boolean;
      limit?: number;
      offset?: number;
    }) => Promise<PlanRecord[]>;
    getPlan: (id: string) => Promise<PlanRecord | null>;
    getPlanVersions: (planId: string) => Promise<PlanVersionRecord[]>;
    confirmPlan: (id: string) => Promise<void>;
    rejectPlan: (id: string) => Promise<void>;
    openPlan: (id: string, target?: string) => Promise<void>;

    // Pull Requests (FEA-1226)
    getPrStats: () => Promise<PrStats>;
    getPrSessions: (opts?: {
      limit?: number;
      offset?: number;
    }) => Promise<PrSessionGroup[]>;
    getPrList: (opts?: {
      sessionId?: string;
      repo?: string;
      limit?: number;
      offset?: number;
    }) => Promise<PrRecord[]>;
    openPr: (id: string) => Promise<void>;

    // Agent Components (FEA-2923 / T-16.3)
    listAgentComponents: (
      filters: AgentComponentQueryFilters
    ) => Promise<AgentComponentListResponse>;
    getAgentComponentDetail: (
      slug: string
    ) => Promise<AgentComponentDetail | null>;

    // Diagnostics (FEA-1959)
    getDiagnostics: () => Promise<DiagnosticsData>;

    // Optimization analytics (FEA-2923 / AC-022)
    /**
     * Per-(component, model) token/cost/latency/truncation time series for a
     * given component over the specified number of trailing days. Joins
     * `agent_component_session_usage` with `token_events`, `token_usage`, and
     * `claude_code_api_request` in the local SQLite DB. Returns empty `points`
     * when the component has no usage in the window.
     */
    getComponentModelTrend: (
      componentKind: string,
      componentKey: string,
      model?: string,
      days?: number
    ) => Promise<ComponentModelTrendResponse>;
    /**
     * Day-bucketed sub-agent pull-in frequency: counts distinct sessions and
     * total invocations per day for the given `subagentKey` over `days` trailing
     * days. Reads `agent_component_session_usage` where `component_kind='subagent'`.
     */
    getSubagentFrequency: (
      subagentKey: string,
      days?: number
    ) => Promise<SubagentFrequencyResponse>;
    /**
     * Checks whether a skill is being loaded (has usage rows) vs. just existing
     * in the inventory. A skill in `agent_components` with no
     * `agent_component_session_usage` rows may not be loading correctly.
     */
    isSkillLoaded: (skillKey: string) => Promise<SkillLoadedResponse>;
  };
  /** Live DB-change push subscription; returns an unsubscribe fn. */
  onDbChanged: (
    callback: (payload: { sessionId?: string }) => void
  ) => () => void;
  /** Server-origin GitHub dirty-scope nudge for branch cache invalidation. */
  onGitHubResyncNudge?: (
    callback: (payload: GitHubResyncNudgeRendererEvent) => void
  ) => () => void;
  /** Subscribe to streamed pack install/uninstall output (FEA-1314). */
  onInstallOutput?: (
    callback: (payload: InstallOutputChunk) => void
  ) => () => void;
  /**
   * Subscribe to opt-in distributions surfaced by the main-process
   * `RequiredPluginInstaller` (FEA-2923 / §I). The renderer presents these for
   * the user to accept/install themselves. Returns an unsubscribe fn.
   */
  onDistributionsOptInAvailable?: (
    callback: (distributions: OptInDistributionDto[]) => void
  ) => () => void;
  /** First-party desktop auth (FEA-2219): current main-process auth state. */
  getDesktopAuthState: () => Promise<DesktopAuthState>;
  /**
   * Begin interactive system-browser sign-in (device-onboarding → exchange).
   * Resolves on the terminal outcome; intermediate progress arrives via
   * {@link onDesktopAuthStateChanged}.
   */
  beginDesktopSignIn: () => Promise<DesktopBrowserSignInResult>;
  /** Cancel an in-flight sign-in (no-op when none is running). */
  cancelDesktopSignIn: () => Promise<void>;
  /** Sign out: best-effort server revoke + clear keychain + access token. */
  signOutDesktop: () => Promise<void>;
  /**
   * Current access token for `Authorization: Bearer`, or null when signed out
   * (refreshes on demand). Never persisted in the renderer.
   */
  getDesktopAccessToken: () => Promise<string | null>;
  /** Current cloud GitHub data-connection status, or null when unavailable. */
  getGitHubIntegrationStatus?: () => Promise<GitHubIntegrationStatus | null>;
  /** Display identity (name, email, org name) for the signed-in desktop session. */
  getDesktopIdentity?: () => Promise<DesktopIdentity | null>;
  /** Open the first-party web GitHub App connect flow from main process. */
  openGitHubConnect: (
    request?: GitHubConnectOpenRequest
  ) => Promise<GitHubConnectOpenResult>;
  /** Subscribe to auth-state pushes; returns an unsubscribe fn. */
  onDesktopAuthStateChanged: (
    callback: (state: DesktopAuthState) => void
  ) => () => void;
};

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged.
  interface Window {
    desktopApi: DesktopApi;
  }
}
