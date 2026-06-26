import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsSection,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
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
import type {
  AgentMonitorHooksResult,
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
  SharedBranchesListRequest,
  SharedBranchesQuery,
} from "../../shared/shared-branches-contract";

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

export type AgentMonitorHookResult = AgentMonitorHooksResult;

export type DesktopFeatureFlagState = {
  key: string;
  value: boolean;
  source: "env" | "user" | "default";
};

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
  getAllFlags: () => Promise<{ flags: DesktopFeatureFlagState[] }>;
  onFlagsChanged?: (callback: () => void) => void;
  /** Run the rendered coaching prompt through the local `claude -p` harness. */
  generateCoachingTips: (prompt: string) => Promise<string>;
  /** Install a reviewed coaching artifact via the chosen local harness. */
  installCoachingArtifact: (draft: string, harness?: string) => Promise<string>;
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
    detail: (id: string) => Promise<BranchPageDetail | null>;
    usage: (request?: SharedBranchesQuery) => Promise<BranchUsageSummary>;
    analytics: (request?: SharedBranchesQuery) => Promise<BranchAnalytics>;
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

    // Diagnostics (FEA-1959)
    getDiagnostics: () => Promise<DiagnosticsData>;
  };
  /** Live DB-change push subscription; returns an unsubscribe fn. */
  onDbChanged: (
    callback: (payload: { sessionId?: string }) => void
  ) => () => void;
  /** Subscribe to streamed pack install/uninstall output (FEA-1314). */
  onInstallOutput?: (
    callback: (payload: InstallOutputChunk) => void
  ) => () => void;
};

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged.
  interface Window {
    desktopApi: DesktopApi;
  }
}
