import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsSection,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import type {
  AgentComponentDetail,
  AgentComponentFrequency,
  AgentComponentListResponse,
  AgentComponentQueryFilters,
  ComponentModelTrendResponse,
  SkillLoadedResponse,
  SubagentFrequencyResponse,
} from "@repo/api/src/types/agent-component";
import type {
  AgentComponentInvocationSessionTreePage,
  AgentComponentInvocationSessionTreeRequest,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import type { AgentComponentVersionUsageResponse } from "@repo/api/src/types/agent-component-version-usage";
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionsPageData,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import type {
  AgentSessionEventsPage,
  AgentSessionEventsPageRequest,
} from "@repo/api/src/types/agent-session-events-page";
import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
} from "@repo/api/src/types/branch";
import type { BranchAnalyticsCohortResponse } from "@repo/api/src/types/branch-analytics-cohort";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import type {
  ConvertInstallOutcome,
  ConvertInstallRequest,
} from "@repo/api/src/types/convert-install";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type {
  DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import type { OptInDistributionDto } from "@repo/api/src/types/distribution";
import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import type { GitHubResyncNudgeBody } from "@repo/api/src/types/github-dirty-scope-constants";
import type {
  AgentComponentPageDataRequest,
  AgentComponentPageDataResult,
} from "@repo/api/src/utils/agent-component-page-data";
import type {
  RelayHttpRequestPayload,
  RelayResponseEnvelope,
} from "@repo/shared-platform/relay-request-model";
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
} from "../../shared/agent-db-contract";
import type {
  CloudApiFetchRequest,
  CloudApiFetchResult,
} from "../../shared/cloud-api-fetch-contract";
import type {
  CoachingHarnessResult,
  CoachingPackInfo,
} from "../../shared/coaching-pack-contract";
import {
  AgentMonitorHooksResult,
  DesktopAuthState,
  DesktopBootstrapOrganizationInput,
  DesktopBootstrapOrganizationResult,
  DesktopBrowserSignInResult,
  DesktopExistingUserResolution,
  DesktopSignInOptions,
  SaveConfigPayload,
  SyncObservabilityTier,
} from "../../shared/contracts";
import type { DeadEndTelemetryPayload } from "../../shared/dead-end-telemetry-contract";
import type { DesktopRealtimeApi } from "../../shared/desktop-realtime-contract";
import type { DesktopSessionReplayBridge } from "../../shared/desktop-session-replay-bridge";
import type {
  DiagnosticsData,
  DiagnosticsRequest,
} from "../../shared/diagnostics-contract";
import type { DirectoryScopePickPayload } from "../../shared/directory-scope-ipc-channel";
import type {
  DocsHelpGetPageResult,
  DocsHelpNavResult,
  DocsHelpSearchResult,
  DocsHelpStatus,
} from "../../shared/docs-help-contract";
import type {
  LocalPriorityWriteRequest,
  LocalPriorityWriteResult,
} from "../../shared/local-priority-write-contract";
import type { LocalSessionSourceStatus } from "../../shared/local-session-source-status";
import type { SharedAgentSessionReadOptions } from "../../shared/read-initiator-contract";
import type {
  RendererOtelBridgePayload,
  RendererOtelExportResult,
} from "../../shared/renderer-otel-bridge-constants";
import type { RendererReadyPhase } from "../../shared/renderer-ready-phase";
import type {
  SessionLimitsSnapshot,
  StatuslineCaptureResult,
} from "../../shared/session-limits-channel.js";
import type {
  SharedAgentSessionsCancelReadResult,
  SharedAgentSessionsListRequest,
  SharedAgentSessionsQuery,
} from "../../shared/shared-agent-sessions-contract";
import type {
  SharedBranchCohortLocalReadRequest,
  SharedBranchesDetailRequest,
  SharedBranchesListRequest,
  SharedBranchesLocalReadRequest,
  SharedBranchesPageDataResponse,
  SharedBranchTraceResponse,
} from "../../shared/shared-branches-contract";
import type {
  SurfaceAnalyticsIpcPayload,
  SurfaceAnalyticsIpcResult,
} from "../../shared/surface-analytics-ipc-contract";
import type { SyncConsentRecord } from "../../shared/sync-consent";
import type { ThreadViewedResult } from "../../shared/thread-viewership-contract";
import type {
  TranscriptCancelRequest,
  TranscriptForceArchiveRequest,
  TranscriptForceArchiveResult,
  TranscriptPrepareRequest,
  TranscriptPrepareResult,
} from "../../shared/transcript-read-contract";
import type { TranscriptSyncStatusSnapshot } from "../../shared/transcript-sync-status-contract";

export type GitHubResyncNudgeRendererEvent = {
  body: GitHubResyncNudgeBody | unknown;
  branchIds?: readonly string[];
};

export type AgentMonitorUrl = {
  url: string | null;
  ready: boolean;
  planExtractionEnabled: boolean;
  localSessionSourceStatus: LocalSessionSourceStatus;
};

export type SandboxInspectResult = {
  path: string;
  isGitRepo: boolean;
  suggestedPath: string | undefined;
  /**
   * FEA-3641: true when the picked folder is a broad/risky root (~,
   * /Users/<name>, a system dir) that must not be used as a sandbox base.
   */
  isRisky: boolean;
  /**
   * ISS-4577: true when the path exists as a directory on disk. Undefined when
   * existence could not be probed (a TCC-protected folder). Absent on older
   * main-process builds, so consumers must treat `undefined` as "unknown" and
   * not assert a missing directory.
   */
  exists?: boolean | undefined;
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
  /** Bring Desktop back to the front once the connect lands. */
  returnToDesktop?: boolean;
};

// ISS-8024: the per-user PostHog assignment the desktop feature-flag provider
// resolves its gates from.
export type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
// Re-exported for the renderer surfaces (e.g. `IdentityDetails`) that read the
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
  DesktopExistingUserResolution,
  DesktopSignInOptions,
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
  getSessionLimits: () => Promise<SessionLimitsSnapshot | null>;
  /** FEA-3492: read the statusline-capture opt-in state. */
  getStatuslineCaptureEnabled: () => Promise<boolean>;
  /** FEA-3492: opt in/out of the statusLine capture (installs/restores config). */
  setStatuslineCaptureEnabled: (
    enabled: boolean
  ) => Promise<StatuslineCaptureResult>;
  updateSettings: (partial: unknown) => Promise<unknown>;
  getRuntimeStatus: () => Promise<unknown>;
  /**
   * FEA-2715 / ISS-4719: per-file transcript archive-lane status for the
   * availability UI (FEA-2716/2717) — `{ enabled, online, files[] }` with the
   * honest per-file synced byte offsets. Returns a disabled snapshot when the
   * transcript-sync flag is off. Mirrors the `desktop:get-transcript-sync-status`
   * handler in `src/main/ipc/runtime-info-ipc.ts`.
   */
  getTranscriptSyncStatus: () => Promise<TranscriptSyncStatusSnapshot>;
  /**
   * FEA-3843 / PRD-555: in-app Docs & Help bridge. Read-only lookups over the
   * build-time bundled `apps/web/content/docs` snapshot — search the local index, fetch a
   * bundled page, read the bundle status (M1), and list the `meta.json` nav tree
   * (M2/FEA-3844). Renderer surfaces stay gated on the `docsHelp` Labs flag.
   * Mirrors the `docsHelp` namespace exposed by the preload in
   * `src/main/preload-common.ts`.
   */
  docsHelp: {
    search: (query: string, limit?: number) => Promise<DocsHelpSearchResult>;
    getPage: (docPath: string) => Promise<DocsHelpGetPageResult>;
    status: () => Promise<DocsHelpStatus>;
    nav: () => Promise<DocsHelpNavResult>;
  };
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
  /**
   * PRD-532 (M4): persist the sync-consent tier chosen in the unified
   * onboarding flow. Validated against the closed literal set in the main
   * process. Resolves with the persisted tier.
   */
  setSyncObservabilityTier: (
    tier: SyncObservabilityTier
  ) => Promise<{ tier: SyncObservabilityTier }>;
  /**
   * FEA-3907: read the current graduated data sync level (Settings "Data &
   * Sync"). The main process returns the recommended default when unset
   * (upgrading installs are migrated on first read), so this never resolves null.
   */
  getDataSyncLevel: () => Promise<{ level: DataSyncLevel }>;
  /**
   * FEA-3907: persist a new data sync level. Validated against the closed
   * literal set in the main process, which derives and persists the
   * connectivity/sync booleans from it. Resolves with the persisted level.
   */
  setDataSyncLevel: (level: DataSyncLevel) => Promise<{ level: DataSyncLevel }>;
  /**
   * ISS-8376: the desktop-local onboarding facts — the transcript byte
   * inventory (ISS-8506) and the analysis ETA (ISS-8507).
   *
   * OPTIONAL because an installed renderer can outlive the preload that
   * exposes it: a build without this bridge must degrade to "no local state"
   * rather than throwing. Resolves `unknown` on purpose — the adapter validates
   * with `parseOnboardingLocalState`, so nothing hands the renderer a shape
   * that was never checked.
   *
   * `attemptId` is echoed back on the response so a reply belonging to a
   * superseded onboarding attempt can be dropped rather than merged.
   */
  getOnboardingLocalState?: (payload?: {
    attemptId?: string;
  }) => Promise<unknown>;
  /**
   * ISS-7249: report one dead-end treatment — the rendered "we could not show
   * you the thing you asked for" state, a retry the user took, or what that
   * retry settled into. Closed enums, a boolean, and two bounded numbers;
   * nothing here can carry a session id, a name, content, or a path.
   */
  recordDeadEndTelemetry: (
    payload: DeadEndTelemetryPayload
  ) => Promise<{ ok: boolean }>;
  /**
   * ISS-5489: whether this device has already answered the sync-consent
   * question, and for which org. A `tier` of null means it never has — the one
   * signal `getDataSyncLevel` cannot give, since it reconciles an unset level
   * into a real one.
   */
  getSyncConsentRecord: () => Promise<SyncConsentRecord>;
  /**
   * ISS-5489: persist the post-auth takeover's answer — the level (through the
   * same consolidated setter Settings uses) plus the org it was given for.
   */
  recordSyncConsent: (payload: {
    level: DataSyncLevel;
    organizationId: string | null;
  }) => Promise<{ level: DataSyncLevel; organizationId: string | null }>;
  /**
   * ISS-10890: record that this device agreed to local session analysis
   * (Welcome's Start). Optional: the browser-bridge mirror does not carry it.
   */
  recordSessionAnalysisAgreement?: () => Promise<{ ok: boolean }>;
  /**
   * ISS-5489: subscribe to consent-record pushes; returns an unsubscribe fn.
   *
   * OPTIONAL for version skew — an already-installed build's preload predates
   * this channel, and the renderer must degrade to re-reading through
   * {@link getSyncConsentRecord} rather than assuming the push exists.
   */
  onSyncConsentRecordChanged?: (
    callback: (record: SyncConsentRecord) => void
  ) => () => void;
  pickSandboxDirectory: () => Promise<SandboxInspectResult | null>;
  inspectSandboxPath: (path: string) => Promise<SandboxInspectResult | null>;
  pickDirectoryScopeEntry: () => Promise<DirectoryScopePickPayload | null>;
  getDangerousAutoApprove: () => Promise<boolean>;
  setDangerousAutoApprove: (enabled: boolean) => Promise<boolean>;
  removeAlwaysAllowRule: (ruleId: string) => Promise<unknown>;
  checkForUpdate: () => Promise<unknown>;
  applyUpdate: () => Promise<unknown>;
  moveToApplications: () => Promise<boolean>;
  isDebugAuthEnabled: () => Promise<boolean>;
  mintDebugToken: (origin?: string) => Promise<unknown>;
  getLogs: () => Promise<unknown>;
  clearLogs: () => Promise<unknown>;
  getLogFilePath: () => Promise<string>;
  openLogFile: () => Promise<unknown>;
  getAppVersion: () => Promise<string>;
  getBinaryPaths: () => Promise<unknown>;
  patchBinaryPaths: (patch: unknown) => Promise<unknown>;
  detectCliTools: () => Promise<unknown>;
  /**
   * Notify main that the desktop renderer reached a readiness milestone.
   * ISS-5346: omitted/`Shell` means the static `index.html` shell painted;
   * `Mounted` means the React entry committed its first render and is what the
   * initial window reveal waits for.
   */
  notifyRendererReady: (phase?: RendererReadyPhase) => void;
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
  /**
   * ISS-8752: relay one surface-attributed analytics event to the main
   * process's product-analytics transport. Optional for preload version skew —
   * the renderer adapter drops events best-effort when absent.
   */
  captureSurfaceAnalytics?: (
    payload: SurfaceAnalyticsIpcPayload
  ) => Promise<SurfaceAnalyticsIpcResult>;
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
  /**
   * FEA-3639: re-run the boot import after the user grants a previously-denied
   * file-access permission, so the now-readable sessions backfill without an
   * app restart.
   */
  reimportAgentSessions?: () => Promise<void>;
  getAllFlags: () => Promise<{ flags: DesktopFeatureFlagState[] }>;
  /** Subscribe to desktop flag-change pushes; returns an unsubscribe fn. */
  onFlagsChanged?: (callback: () => void) => () => void;
  /**
   * Run the rendered coaching prompt through the local `claude -p` harness.
   * Resolves to a structured result for BOTH success and operational failure
   * (timeout / spawn error / non-zero exit) — it never rejects, so the caller
   * degrades to built-in tips instead of surfacing a raw handler error.
   */
  generateCoachingTips: (prompt: string) => Promise<CoachingHarnessResult>;
  /**
   * Install a reviewed coaching artifact. `kind` (FEA-3687 #4) selects the
   * deterministic new-file skill install (`create-new-file`, the default) vs the
   * LLM-driven edit across existing `.claude/*` files (`edit-existing`, which
   * uses `harness`). An absent/invalid `kind` defaults to `create-new-file`.
   */
  installCoachingArtifact: (
    draft: string,
    harness?: string,
    kind?: string
  ) => Promise<CoachingHarnessResult>;
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
    componentScopeVersion?: number;
    list: (
      request?: SharedAgentSessionsListRequest
    ) => Promise<AgentSessionListResponse>;
    detail: (
      id: string,
      options?: SharedAgentSessionReadOptions
    ) => Promise<AgentSessionDetail | null>;
    usage: (
      request?: SharedAgentSessionsQuery
    ) => Promise<AgentSessionUsageSummary>;
    analytics: (
      request?: SharedAgentSessionsQuery
    ) => Promise<AgentSessionAnalytics>;
    /** FEA-4157: combined list + usage read, one raw scan shared. */
    pageData: (
      request?: SharedAgentSessionsListRequest
    ) => Promise<AgentSessionsPageData>;
    /**
     * ISS-9857: one keyset page of raw events past the detail's bounded
     * prefix. `null` is the fail-closed answer (unknown session, malformed
     * cursor, disabled runtime); the local data source maps it to a 404.
     * Optional because the mirrored web renderer can run against an installed
     * build whose preload predates the channel; the local source then omits
     * its own `eventsPage`, so the panel offers no continuation.
     */
    eventsPage?: (
      request: AgentSessionEventsPageRequest
    ) => Promise<AgentSessionEventsPage | null>;
    /**
     * ISS-10737: every agent-component invocation of one session, as the Trace
     * tab's tree. `null` is the fail-closed answer (unknown session, a source
     * that cannot serve it, disabled runtime); the local data source maps it to
     * a 404. Optional for the same version-skew reason `eventsPage` is — a
     * mirrored renderer can run against an installed build whose preload
     * predates the channel, and the local source then omits its own
     * `sessionInvocationTree`, which the Trace tab reads as "this source cannot
     * serve a tree" rather than as an empty one.
     */
    invocationTree?: (
      request: AgentComponentInvocationSessionTreeRequest
    ) => Promise<AgentComponentInvocationSessionTreePage | null>;
    /**
     * ISS-9802: abandon the in-flight read carrying `token`. Optional for the
     * same version-skew reason `eventsPage` is — a mirrored renderer can run
     * against an installed build whose preload predates the bridge — and the
     * local data source PROBES for it, reporting `cancelsInFlightReads: false`
     * and falling back to today's behaviour when it is absent.
     */
    cancelRead?: (
      token?: string
    ) => Promise<SharedAgentSessionsCancelReadResult>;
    /**
     * ISS-10332: set or clear a local session's priority. Optional for the
     * same version-skew reason as `eventsPage`; the local data source probes
     * for it and offers no `updatePriority` — so no editor — when absent.
     */
    updatePriority?: (
      request: LocalPriorityWriteRequest
    ) => Promise<LocalPriorityWriteResult>;
  };
  /** Local shared Branches API adapter exposed by the design-system preload. */
  branchesApi: {
    list: (request?: SharedBranchesListRequest) => Promise<BranchListResponse>;
    detail: (
      request: string | SharedBranchesDetailRequest
    ) => Promise<BranchPageDetail | null>;
    /** PLN-1148 Phase 2: lazy events-heavy merged trace for the timeline tab. */
    trace: (id: string) => Promise<SharedBranchTraceResponse>;
    usage: (
      request?: SharedBranchesLocalReadRequest
    ) => Promise<BranchUsageSummary>;
    analytics: (
      request?: SharedBranchesLocalReadRequest
    ) => Promise<BranchAnalytics>;
    /** Additive in newer preloads; older installed mains may omit it. */
    cohortAnalytics?: (
      request: SharedBranchCohortLocalReadRequest
    ) => Promise<BranchAnalyticsCohortResponse | null>;
    /** FEA-3056 follow-up: combined list + analytics read, one raw scan shared. */
    pageData: (
      request?: SharedBranchesListRequest
    ) => Promise<SharedBranchesPageDataResponse>;
    /** ISS-10332: set or clear a local branch's priority; optional like `cohortAnalytics`. */
    updatePriority?: (
      request: LocalPriorityWriteRequest
    ) => Promise<LocalPriorityWriteResult>;
  };
  /** Database IPC channels (typed against the in-process repository shapes). */
  db: {
    getSessions: () => Promise<SessionRow[]>;
    getSession: (id: string) => Promise<SessionRow | undefined>;
    getSessionDetails: (id: string) => Promise<SessionWithAgents | undefined>;
    /**
     * ISS-7830: record that the user navigated INTO this thread. Monotonic — the
     * first view is the one kept, so a caller may fire it on every mount.
     */
    markSessionViewed: (id: string) => Promise<ThreadViewedResult>;
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
    /**
     * FEA-3722: `lookbackDays` windows the token/tool-usage facets — omitted
     * keeps the 30-day default; a positive number sets that rolling window;
     * `null` means all-time. The Coding Wrap passes the top date-range selection.
     */
    getAnalytics: (lookbackDays?: number | null) => Promise<AnalyticsData>;
    getWorkflowData: () => Promise<WorkflowQueryData>;
    getCoreFeatures: () => Promise<DashboardCoreFeatures>;
    getPacks: () => Promise<DashboardPackSummary[]>;
    getSkills: () => Promise<DashboardSkillSummary[]>;
    getTools: () => Promise<DashboardToolSummary[]>;
    getSubAgents: () => Promise<DashboardSubAgentSummary[]>;
    getPlans: (opts?: DashboardListWindow) => Promise<DashboardPlanSummary[]>;
    getPullRequests: (
      opts?: DashboardListWindow
    ) => Promise<DashboardPullRequestSummary[]>;

    // Catalog (FEA-1314)
    getCatalog: () => Promise<CatalogEntry[]>;
    /** Cloud: org-wide analytics for a pack (desktop-team overlay). */
    getPackAnalytics: (packId: string) => Promise<PackAnalyticsResponse | null>;
    getCatalogEntry: (packId: string) => Promise<CatalogEntry | null>;
    getCatalogContents: (
      packId: string
    ) => Promise<CatalogContentItem[] | null>;
    getCatalogHistory: (
      packId: string
    ) => Promise<Array<{ fetchedAt: string; stars: number; forks: number }>>;
    catalogInstall: (
      packId: string,
      harness: string,
      cwd?: string
    ) => Promise<CatalogMutationResult>;
    /**
     * Convert a component to the target harness's format and install it, as one
     * gateway operation (FEA-4079). Resolves to a {@link ConvertInstallOutcome}
     * carrying the honest boundary state (converting / partial / unsupported /
     * transient-vs-permanent error) and the preserved source-harness provenance.
     */
    catalogConvertInstall: (
      request: ConvertInstallRequest
    ) => Promise<ConvertInstallOutcome>;
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
    /**
     * Durably record a decline/dismiss of an opt-in distribution by id
     * (FEA-4050). Routes to the main-process handler, which resolves the
     * distribution identity cloud-authoritatively and persists it in the
     * settings store so the reconcile no longer re-surfaces the dismissed pack
     * after an app restart. Resolves once persisted; never rejects on the
     * not-connected path (the banner already suppressed the row for the
     * session).
     */
    declineDistribution: (distributionId: string) => Promise<void>;
    /**
     * Re-assert against the cloud that an opt-in distribution is still assigned
     * (ISS-5123). Rejects when the org has withdrawn it, so the generic accept
     * path — which otherwise installs from renderer-held state alone — cannot
     * install a pack that is no longer offered. Also rejects when not connected:
     * an unconfirmable offer must not install.
     */
    ensureDistributionAssigned: (distributionId: string) => Promise<void>;
    /** Refresh the retained offer snapshot after a generic install succeeds. */
    acknowledgeDistributionHandled: (distributionId: string) => Promise<void>;
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
    getAgentComponentFrequency?: (
      slug: string,
      windowDays: number
    ) => Promise<AgentComponentFrequency | null>;
    /**
     * ISS-6822: the bounded page-data read — the visible page, the matched
     * total, the facet counts, and the current window's aggregate, reduced in
     * the main process beside the SQLite read.
     *
     * OPTIONAL because an installed build's preload may predate it. The local
     * data source probes for it and omits its own `pageData` when it is missing,
     * which keeps the shared Agents list on the `listAgentComponents` path
     * rather than failing.
     */
    getAgentComponentsPageData?: (
      request: AgentComponentPageDataRequest
    ) => Promise<AgentComponentPageDataResult>;
    /**
     * ISS-10467/ISS-10468: one or more content versions' own usage for the
     * component detail's drill-down and side-by-side compare.
     *
     * OPTIONAL because an installed build's preload may predate it. The local
     * data source probes for it and omits its own `versionUsage` when it is
     * missing, which makes the shared panel say the capability is absent rather
     * than render figures nobody measured.
     */
    getAgentComponentVersionUsage?: (
      slug: string,
      versionHashes: readonly string[]
    ) => Promise<AgentComponentVersionUsageResponse | null>;

    // Diagnostics (FEA-1959)
    getDiagnostics: (request?: DiagnosticsRequest) => Promise<DiagnosticsData>;

    // Optimization analytics (FEA-2923 / AC-022)
    /**
     * Per-(component, model) token/cost/latency/truncation time series for a
     * given component over the specified number of trailing days. Joins
     * `agent_component_session_usage` with `token_events`, `token_usage`, and
     * `claude_code_api_request` in the local SQLite DB. Returns empty `points`
     * when the component has no usage in the window.
     *
     * ISS-4403: `fingerprint` (optional) is the FULL content hash of the routed
     * component version (`AgentComponentDetail.versionId`). When supplied the read
     * is content-scoped to exactly that version so two same-name/different-content
     * components no longer share one component's analytics (FEA-4335); omitted →
     * name-level (pre-ISS-4403 behavior, and the version-skew-safe default).
     */
    getComponentModelTrend: (
      componentKind: string,
      componentKey: string,
      model?: string,
      days?: number,
      fingerprint?: string
    ) => Promise<ComponentModelTrendResponse>;
    /**
     * Day-bucketed sub-agent pull-in frequency: counts distinct sessions and
     * total invocations per day for the given `subagentKey` over `days` trailing
     * days. Reads `agent_component_session_usage` where `component_kind='subagent'`.
     * ISS-4403: `fingerprint` (optional) content-scopes the read; omitted →
     * name-level.
     */
    getSubagentFrequency: (
      subagentKey: string,
      days?: number,
      fingerprint?: string
    ) => Promise<SubagentFrequencyResponse>;
    /**
     * Checks whether a skill is being loaded (has usage rows) vs. just existing
     * in the inventory. A skill in `agent_components` with no
     * `agent_component_session_usage` rows may not be loading correctly.
     * ISS-4403: `fingerprint` (optional) content-scopes the usage aggregate;
     * omitted → name-level.
     */
    isSkillLoaded: (
      skillKey: string,
      fingerprint?: string
    ) => Promise<SkillLoadedResponse>;
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
  beginDesktopSignIn: (
    method?: DesktopSignInMethod,
    emailHint?: string,
    framing?: DesktopSignInFraming,
    options?: DesktopSignInOptions
  ) => Promise<DesktopBrowserSignInResult>;
  /** Cancel an in-flight sign-in (no-op when none is running). */
  cancelDesktopSignIn: () => Promise<void>;
  /**
   * ISS-11345: confirm the account a `confirmAccount` sign-in is holding
   * (`DesktopAuthState.pendingAccount`). Optional so a partial test stub need
   * not supply it.
   */
  confirmDesktopSignIn?: () => Promise<void>;
  /** Consume the main-held bootstrap capability to create the first org. */
  createBootstrapOrganization?: (
    input: DesktopBootstrapOrganizationInput
  ) => Promise<DesktopBootstrapOrganizationResult>;
  /** Sign out: best-effort server revoke + clear keychain + access token. */
  signOutDesktop: () => Promise<void>;
  /**
   * Cloud-API fetch bridge (PLN-1138 D-G Option B): executes an
   * origin-relative cloud REST request in the main process, which attaches the
   * real Authorization header. The access token never enters the renderer;
   * the auth port surfaces only a sentinel.
   */
  cloudApiFetch: (
    request: CloudApiFetchRequest
  ) => Promise<CloudApiFetchResult>;
  /** PLN-2162 M4: absent from a preload that predates it, which leaves the renderer polling. */
  realtime?: DesktopRealtimeApi;
  /**
   * Cloud-transcript read bridge (FEA-3324 Option B2): asks the main process to
   * prepare a transcript file by id. Main mints the signed S3 URL itself,
   * streams the bytes into a local cache, and returns an opaque same-origin
   * `app://renderer/transcripts/…` URL the renderer fetches with no transcript
   * origin in `connect-src`. The transcript bytes never cross IPC.
   */
  prepareTranscript?: (
    request: TranscriptPrepareRequest
  ) => Promise<TranscriptPrepareResult>;
  /**
   * Abort an in-flight {@link prepareTranscript} by its `requestId` (FEA-3678).
   * The S3 byte download runs in the main process, so a renderer-side query abort
   * cannot stop it — this tells main to abort the matching download mid-stream so
   * the transfer (and its egress) stops when the user clicks Cancel. Best-effort:
   * an unknown/already-finished `requestId` is a no-op.
   */
  cancelTranscriptPrepare?: (request: TranscriptCancelRequest) => Promise<void>;
  /**
   * Force-archive override (FEA-3489 / PRD-536): re-queue ONE oversized transcript
   * that the automatic archive lane dead-lettered for exceeding the size cap and
   * upload it past that cap for this file only (one-shot, per-file), reusing the
   * existing resumable upload lane. Desktop-only (needs the LOCAL file). Present
   * only under the desktop preload; the web transport leaves it undefined so the
   * panel shows the action disabled with an explanation.
   */
  forceArchiveTranscript?: (
    request: TranscriptForceArchiveRequest
  ) => Promise<TranscriptForceArchiveResult>;
  /** Current cloud GitHub data-connection status, or null when unavailable. */
  getGitHubIntegrationStatus?: () => Promise<GitHubIntegrationStatus | null>;
  /** Display identity (name, email, org name) for the signed-in desktop session. */
  getDesktopIdentity?: () => Promise<DesktopIdentity | null>;
  /**
   * ISS-8379 — the Settings local-device snapshot (machine name, platform, app
   * version, gateway port/reachability, and the cloud compute-target id while
   * online). Resolves `unknown`: the caller validates it with
   * `parseSettingsLocalDeviceSnapshot`, so an unvalidated payload cannot reach a
   * panel. OPTIONAL for version skew — an installed build's preload predates
   * this channel, and the adapter degrades to an `unavailable` projection rather
   * than assuming the method exists.
   */
  getSettingsLocalDevice?: () => Promise<unknown>;
  /**
   * ISS-8024 — the signed-in user's PostHog feature-flag assignment, evaluated
   * server-side against the same distinct ids the web app resolves from. `null`
   * for a signed-out session, an unreachable bridge, or any transport/schema
   * failure; the provider reads `null` as UNRESOLVED, so every gate stays
   * closed. Optional: an older preload does not expose it.
   */
  getDesktopFeatureFlags?: () => Promise<DesktopFeatureFlagAssignment | null>;
  /**
   * ISS-12048 — this device's Dev Tools overrides for main's own flag reads, or
   * an empty record. Main applies them only under its own Dev Mode check.
   * Optional: an older preload does not expose it.
   */
  setFeatureFlagOverrides?: (
    overrides: Readonly<Record<string, boolean>>
  ) => Promise<boolean>;
  /** ISS-12048 — the flag keys main checked while in Dev Mode; validate it. */
  getMainCheckedFeatureFlags?: () => Promise<unknown>;
  /** ISS-12048 — main checked a key it had not reported; returns unsubscribe. */
  onMainCheckedFeatureFlagsChanged?: (callback: () => void) => () => void;
  /**
   * ISS-8753 — the Electron E2E harness's seeded flag assignment for this
   * launch, or `null`.
   *
   * `null` on every shipped launch: main refuses a packaged build before it
   * reads argv, and refuses an unpackaged one that was not started with the
   * harness launch argument, so nothing a user can write on their own machine
   * answers here. Optional in the same sense as the member above — an older
   * preload does not expose it, and a renderer test that hand-writes
   * `window.desktopApi` omits it — and its absence reads as "no seed".
   */
  getE2eSeededFeatureFlags?: () => Promise<DesktopFeatureFlagAssignment | null>;
  /** Open the first-party web GitHub App connect flow from main process. */
  openGitHubConnect: (
    request?: GitHubConnectOpenRequest
  ) => Promise<GitHubConnectOpenResult>;
  /** ISS-12257: see {@link DesktopSessionReplayBridge}. */
  reportDesktopReplayRecording?: DesktopSessionReplayBridge["reportDesktopReplayRecording"];
  /** Subscribe to auth-state pushes; returns an unsubscribe fn. */
  onDesktopAuthStateChanged: (
    callback: (state: DesktopAuthState) => void
  ) => () => void;
  /**
   * Existing-user resolution (PRD-532 §8 / M6): the derived, non-secret
   * one-time "Sign in with GitHub to sync" prompt state for a user who has an
   * `sk_live_*` API key but no first-party session. Advisory only — never
   * blocks; no token/key material crosses this boundary.
   */
  getExistingUserResolution?: () => Promise<DesktopExistingUserResolution>;
  /** Record that the existing-user sync prompt was dismissed (persisted, one-time). */
  dismissExistingUserPrompt?: () => Promise<void>;
  /** Subscribe to existing-user resolution pushes; returns an unsubscribe fn. */
  onExistingUserResolutionChanged?: (
    callback: (resolution: DesktopExistingUserResolution) => void
  ) => () => void;
};

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged.
  interface Window {
    desktopApi: DesktopApi;
  }
}
