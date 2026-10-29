import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  app,
  dialog,
  ipcMain,
  Notification,
  nativeImage,
  shell,
} from "electron";
import pkg from "electron-updater";
import { getCodePluginVersion } from "../server/operations/plugin-cache.js";
import {
  computeSymphonyDir,
  SymphonyDirNotConfiguredError,
} from "../server/operations/symphony-utils.js";
import type {
  DesktopSecurityUpgradePayload,
  DesktopSecurityUpgradeResult,
} from "../server/router.js";
import { DesktopGatewayServer } from "../server/server.js";
import {
  type AgentMonitorRuntimeStatus,
  resolveCaptureLivenessStatus,
  STARTING_AGENT_MONITOR_RUNTIME_STATUS,
} from "../shared/agent-monitor-status.js";
import { CloudSocketState } from "../shared/cloud-socket-error.js";
import {
  EMPTY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
} from "../shared/contracts.js";
import { DesktopRendererEventChannel } from "../shared/desktop-renderer-event-channel.js";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../shared/local-session-source-status.js";
import {
  buildAllowedDirectories,
  normalizeScopePath,
} from "../shared/sandbox-policy.js";
import { SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST } from "../shared/shared-agent-sessions-contract.js";
import { SHARED_BRANCHES_IPC_CHANNEL_LIST } from "../shared/shared-branches-contract.js";
import { syncAgentMonitorHooksOnBoot } from "./agent-monitor/agent-monitor-hooks.js";
import type { AgentComponentInvocationSyncService } from "./agent-sync/agent-component-invocation-sync-service.js";
import { createNegotiatedSessionSyncCapabilities } from "./agent-sync/agent-session-sync-capabilities.js";
import type { AgentSessionSyncService } from "./agent-sync/agent-session-sync-service.js";
import {
  type AuthSessionLaneRecovery,
  wireAuthSessionLaneRecovery,
} from "./agent-sync/auth-session-lane-recovery.js";
import {
  type ComputeTargetLinkBlockWiring,
  createComputeTargetLinkBlockWiring,
} from "./agent-sync/compute-target-link-block-wiring.js";
import {
  createDesktopSyncLanes,
  type DesktopSyncLanes,
  refreshDesktopSyncWriteLanes,
  startDesktopSyncLanes,
  stopDesktopSyncLanes,
} from "./agent-sync/desktop-sync-lane-composition.js";
import { buildDesktopSyncLaneDeps } from "./agent-sync/desktop-sync-lane-deps.js";
import * as syncLaneFactories from "./agent-sync/desktop-sync-lane-factories.js";
import { identityBoundComputeTargetId } from "./agent-sync/identity-bound-compute-target.js";
import { createSessionSyncIdentityAdapter } from "./agent-sync/retained-compute-target-identity.js";
import { createSyncEgressGateAdapter } from "./agent-sync/sync-egress-gate-adapter.js";
import { createAuthSessionLaneKicks } from "./agent-sync/sync-lane-kicks.js";
import { ApprovalEvaluator } from "./approvals/approval-evaluator.js";
import { SUPPORTED_OPERATION_IDS } from "./approvals/approval-operations.js";
import type { ApprovalStore } from "./approvals/approval-store.js";
import { ApiKeyIdentityResolver } from "./auth/api-key-identity-resolver.js";
import type {
  DesktopPopHeaders,
  DesktopPopSigningRequest,
} from "./auth/desktop-pop.js";
import { signDesktopRequestWithStoredKey } from "./auth/desktop-pop-sign-utils.js";
import { GatewayIdentityStore } from "./auth/gateway-identity.js";
import type { LocalSessionStore } from "./auth/local-session-store.js";
import { admitInboundCloudCommand } from "./cloud/cloud-command-admission.js";
import { CloudCommandExecutor } from "./cloud/cloud-command-executor.js";
import type {
  CloudSocketStatus,
  DesktopCommandEvent,
} from "./cloud/cloud-protocol.js";
import { CLOUD_DISABLED_BY_USER_STATUS } from "./cloud/cloud-protocol.js";
import { CloudSocketService } from "./cloud/cloud-socket.js";
import { buildPausedAwarePresence } from "./cloud/cloud-socket-payloads.js";
import {
  CloudSocketStartupCoordinator,
  logCloudSocketStartupFailure,
} from "./cloud/cloud-socket-startup.js";
import { createConnectionLifecycleReporter } from "./cloud/connection-lifecycle-reporter.js";
import { createObservabilityLaneRouter } from "./cloud/observability-lane-router.js";
import { handleSecurityUpgradeCommand as runSecurityUpgradeCommand } from "./cloud/security-upgrade-command.js";
import type { GatewaySigningKeyStore } from "./command-signing/gateway-signing-key-store.js";
import {
  createDesktopApplicationServices,
  type DesktopApplicationOptions,
  type DesktopServices,
  type DesktopServicesHost,
} from "./composition/desktop-services.js";
import { createGatewayPackInstaller } from "./composition/gateway-pack-install.js";
import type { ClaudeCodeAnalyticsService } from "./cost/claude-code-analytics-service.js";
import type { CostReconciliationService } from "./cost/cost-reconciliation-service.js";
import {
  type MeteredUsageRow,
  reconciliationCutoffIso,
} from "./cost/reconciliation-worker.js";
import type { AgentDashboardDesignSystemRuntime } from "./dashboard/agent-dashboard-design-system-runtime.js";
import {
  DESIGN_SYSTEM_DB_IPC_CHANNELS,
  installDisabledAgentDashboardDbIpcHandlers,
} from "./dashboard/agent-dashboard-ipc-contract.js";
import { bootstrapAgentDashboardRuntime } from "./dashboard/agent-dashboard-runtime-bootstrap.js";
import type { ActivityLogStore } from "./diagnostics/activity-log-store.js";
import {
  type DocsHelpService,
  loadDocsHelpService,
} from "./docs-help/docs-bundle.js";
import { handleGitHubResyncNudgeFromApp as handleReservedGitHubResyncNudge } from "./github/github-resync-nudge.js";
import type { BinaryPathPatch, CliBinaryTool } from "./ipc/binary-paths-ipc.js";
import { DESKTOP_AUTH_STATE_CHANGED_CHANNEL } from "./ipc/desktop-auth-ipc.js";
import { registerDesktopIpcHandlers } from "./ipc/desktop-ipc-registration.js";
import { scheduleAfterBootAdmission } from "./lifecycle/boot-admission-deadline.js";
import {
  reportDesktopShutdownFailure,
  runDesktopApplicationShutdown,
} from "./lifecycle/desktop-application-shutdown.js";
import { GatewayRecoveryManager } from "./lifecycle/gateway-recovery.js";
import { WindowShowIntent } from "./lifecycle/initial-window-reveal-gate.js";
import { RendererReadinessGates } from "./lifecycle/renderer-readiness-gates.js";
import {
  deleteRetiredHomeFiles,
  deleteRetiredStoreFiles,
} from "./lifecycle/retired-store-files.js";
import type { ShutdownResult } from "./lifecycle/shutdown.js";
import { gatewayLog } from "./logging/gateway-logger.js";
import {
  describeDesktopBootIdentity,
  readPreviousSessionLogTail,
} from "./logging/persistent-log.js";
import { resolveDesktopMachineName } from "./machine-name.js";
import type { BootstrapClaimDiagnostic } from "./onboarding/bootstrap-claim.js";
import { ManagedOnboardingController } from "./onboarding/managed-onboarding-controller.js";
import { createSessionAnalysisConsentGate } from "./onboarding/session-analysis-consent-gate.js";
import { isDesktopSetupCompleteFromState } from "./onboarding/setup-readiness.js";
import { createCoachingPackController } from "./packs/coaching-pack-controller.js";
import { RequiredPluginInstaller } from "./packs/required-plugin-installer.js";
import { buildRequiredPluginInstallerOptions } from "./packs/required-plugin-installer-options.js";
import { resolveResourcesDir } from "./resources-dir.js";
import { reconcileDesktopAccountChange } from "./session/desktop-account-lifecycle.js";
import { DesktopCredentialStoreAdapter } from "./session/desktop-credential-store-adapter.js";
import type { DesktopSessionManager } from "./session/desktop-session-manager.js";
import type { DesktopSessionStore } from "./session/desktop-session-store.js";
import { coordinateDesktopSignOut } from "./session/desktop-sign-out.js";
import { clearOrgDirectoryCache } from "./session/org-directory-cache.js";
import {
  type SessionTerminalNotice,
  notifySessionTerminal as showSessionTerminalNotification,
} from "./session/session-terminal-notification.js";
import { SignOutLoopCleanup } from "./session/sign-out-loop-cleanup.js";
import { wireOrgDirectoryPersistence } from "./session/wire-org-directory-persistence.js";
import { SessionLimitsBoot } from "./session-limits/session-limits-boot.js";
import { createSessionLimitsGate } from "./session-limits/session-limits-gate.js";
import { createDesktopSessionMeshController } from "./session-mesh/session-mesh-composition.js";
import { resolveActiveGatewayId } from "./settings/active-gateway-id.js";
import type { ApiKeyStore } from "./settings/api-key-store.js";
import { applyDataSyncLevel } from "./settings/apply-data-sync-level.js";
import { applyBinaryPathPatchAndInvalidateCaches as applyBinaryPathOverride } from "./settings/binary-path-override.js";
import type { GoldenModeConfig } from "./settings/golden-mode.js";
import { seedReposConfig } from "./settings/seed-repos-config.js";
import { setCloudConnectionEnabled } from "./settings/set-cloud-connection-enabled.js";
import type { SettingsStore } from "./settings/settings-store.js";
import type { SyncBurndownReporter } from "./sync/sync-burndown-reporter.js";
import type { DesktopOtelRuntime } from "./telemetry/app-otel-runtime.js";
import {
  type DesktopAppLifecycleTelemetry,
  startDesktopOtelRuntimeForBoot,
} from "./telemetry/app-otel-runtime-lifecycle.js";
import { getDesktopAppOperatingModeForTelemetry } from "./telemetry/app-telemetry-operating-mode.js";
import { Observability } from "./telemetry/observability.js";
import { createPreAuthAnalyticsIdentityReads } from "./telemetry/preauth-analytics-identity.js";
import type { TelemetryOrgProvider } from "./telemetry/telemetry-org-identity.js";
import type { DesktopShutdownDiagnostics } from "./telemetry/telemetry-protocol.js";
import { resolveDesktopTranscriptStateDir } from "./transcript-sync/transcript-state-dir.js";
import type { TranscriptSyncService } from "./transcript-sync/transcript-sync-service.js";
import { setMaterializedOpencodeTranscriptRoot } from "./transcript-sync/trusted-transcript-path.js";
import type { DesktopTray } from "./tray.js";
import { refreshDesktopTrayState } from "./tray-state.js";
import { installDesktopUpdateLane } from "./update/auto-update-wiring.js";
import {
  applyDevUpdate,
  checkForDevUpdate,
  DEV_UPDATE_READY_STATUS,
  type DevUpdateCheckResult,
} from "./update/dev-update-commands.js";
import { isFakeUpdateFeedActive } from "./update/fake-update-feed.js";
import { finishPackagedUpdateInstall } from "./update/finish-update-install.js";
import {
  createInitialPackagedUpdateState,
  mergePackagedUpdateState,
  type PackagedUpdateState,
  type PackagedUpdateStatusPayload,
  toPackagedUpdateStatusPayload,
} from "./update/packaged-update-state.js";
import { UpdateBlockedController } from "./update/update-blocked-controller.js";
import { guardUpdateDownloadPromise } from "./update/update-install-blocked.js";
import {
  createDesktopUpdateLifecycleReporter,
  type DesktopUpdateLifecycleReporter,
} from "./update/update-lifecycle-telemetry.js";
import { resolveUpdateRestartTargetVersion } from "./update/update-restart-target.js";
import { createUpdateTelemetryStore } from "./update/update-telemetry-store.js";
import { yieldToMainLoop } from "./util/main-loop-scheduling.js";
import type { NodeUuidStore } from "./util/node-uuid-store.js";
import {
  createQueueStatsDebounce,
  type QueueStatsDebounce,
} from "./util/queue-stats-debounce.js";
import { createUserIdentityChangeSubscription } from "./util/user-identity.js";
import type { DesktopWindow } from "./window.js";

const { autoUpdater } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The launch options live with the composition root that consumes them
// (composition/desktop-services.ts); re-exported here so `startup.ts` and any
// other caller keep importing them from the application module as before.
export type { DesktopApplicationOptions } from "./composition/desktop-services.js";
export class DesktopApplication {
  // FEA-2648: null for a normal launch. When set, isolation is already applied
  // (userData redirected in startup.ts); consumers thread it to window/tray and
  // the agent-dashboard runtime + cloud guards.
  private readonly goldenMode: GoldenModeConfig | null;
  private readonly settingsStore: SettingsStore;
  private readonly apiKeyStore: ApiKeyStore;
  private readonly gatewaySigningKeyStore: GatewaySigningKeyStore;
  private readonly desktopSessionStore: DesktopSessionStore;
  private readonly desktopSessionManager: DesktopSessionManager;
  private readonly credentialStore: DesktopCredentialStoreAdapter;
  private readonly nodeUuidStore: NodeUuidStore;
  private readonly appOtelRuntime: DesktopOtelRuntime;
  /** ISS-6334: shared auth-failure reporter; every reference is a lazy lambda. */
  private readonly reportAuthFailure: DesktopServices["reportAuthFailure"];
  private readonly telemetryOrgProvider: TelemetryOrgProvider;
  private readonly apiKeyIdentityResolver = new ApiKeyIdentityResolver({
    getApiKey: () => this.apiKeyStore.getApiKey(),
    getApiOrigin: () => this.settingsStore.getApiOrigin(),
  });
  private readonly appLifecycleTelemetry: DesktopAppLifecycleTelemetry;
  /**
   * ISS-7247: whether OTel came up on this boot. Read by the update reconciler,
   * which must not count a boot it could not have reported from.
   */
  private appOtelRuntimeStarted = false;
  private readonly updateTelemetry: DesktopUpdateLifecycleReporter;
  private readonly tray: DesktopTray;
  private readonly desktopWindow: DesktopWindow;
  private readonly server: DesktopGatewayServer;
  private readonly cloudSocket: CloudSocketService;
  private readonly realtimeHost: DesktopServices["realtimeHost"];
  private readonly commandExecutor: CloudCommandExecutor;
  private agentDashboardDesignSystem: AgentDashboardDesignSystemRuntime | null =
    null;
  private disabledAgentDashboardDbIpcRegistered = false;
  // FEA-3843 / PRD-555 (M1): in-app Docs & Help service (build-time bundle +
  // local search index). Built once from the embedded snapshot manifest; the
  // `docs-help` IPC handler reads through it.
  private readonly docsHelp: DocsHelpService = loadDocsHelpService();
  private readonly agentSessionSync: AgentSessionSyncService;
  private readonly agentComponentInvocationSync: AgentComponentInvocationSyncService;
  /** Every cloud sync lane, for the one lifecycle owner that starts and stops them. */
  private readonly syncLanes: DesktopSyncLanes;
  /** ISS-5387: read-only periodic burn-down over every desktop→cloud sync lane. */
  private readonly syncBurndownReporter: SyncBurndownReporter;
  /** ISS-11426: the ONE compute-target link block; see the wiring module. */
  private readonly computeTargetLinkBlock: ComputeTargetLinkBlockWiring =
    createComputeTargetLinkBlockWiring(() => this.onlineComputeTargetId());
  // Session-limit snapshot producers (statusline capture + the owned `/usage`
  // endpoint). Started as one unit; no-op in golden mode.
  private sessionLimitsBoot: SessionLimitsBoot | null = null;
  // ISS-8792: `subscriptionSessionLimits` is read by the renderer too, so main
  // takes the same PostHog verdict — and re-attempts when it lands, because
  // `UsageApiService.start()` schedules no timer while the gate reads closed.
  private readonly sessionLimitsGate = createSessionLimitsGate({
    getProducers: () => this.sessionLimitsBoot,
    isShuttingDown: () => this.shuttingDown,
    logWarning: (message) => gatewayLog.warn("session-limits", message),
  });
  private readonly sessionAnalysisConsent = createSessionAnalysisConsentGate({
    isGoldenMode: () => this.goldenMode !== null,
    isShuttingDown: () => this.shuttingDown,
    logWarning: (message) => gatewayLog.warn("agent-monitor", message),
    settings: () => this.settingsStore,
  });
  // FEA-2923 (T-16.8/10): auto-install distributions on cloud online transition.
  private readonly requiredPluginInstaller: RequiredPluginInstaller;
  // FEA-2715: raw-transcript archive lane. Null unless the desktop feature flag
  // is on (constructed lazily in the ctor). Entirely separate from the metadata
  // lane above; a transcript failure never touches agentSessionSync. Not
  // `readonly`: `applyDataSyncLevel` can lazily (re)create it when a live level
  // change first turns the transcript lane on this session (FEA-3907).
  private transcriptSync: TranscriptSyncService | null;
  // ISS-9418 / ISS-8610: the auth-session → lane recovery seam. Shutdown-gated,
  // so a notification landing during teardown cannot re-arm a stopped lane (see
  // auth-session-lane-recovery.ts).
  private authSessionLaneRecovery: AuthSessionLaneRecovery | null = null;
  private readonly costReconciliation: CostReconciliationService;
  private readonly claudeCodeAnalytics: ClaudeCodeAnalyticsService;
  private readonly activityLog: ActivityLogStore;
  private readonly approvalStore: ApprovalStore;
  private readonly recovery: GatewayRecoveryManager;
  private readonly signOutLoopCleanup: SignOutLoopCleanup;
  private readonly gatewayAuthToken: string;
  private readonly gatewayIdentity: GatewayIdentityStore;
  private readonly sessionStore: LocalSessionStore;
  private shuttingDown = false;
  private dangerousAutoApprove = false;
  private readonly approvalEvaluator: ApprovalEvaluator;
  private readonly managedOnboarding: ManagedOnboardingController;
  private cloudStatus: CloudSocketStatus = { state: "idle" };
  /** ISS-8691: which compute target the session lane writes under, and whether it may write at all. */
  private readonly sessionSyncIdentity = createSessionSyncIdentityAdapter({
    getIdentity: () => this.desktopSessionManager.getIdentity(),
    getAuthStatus: () => this.desktopSessionManager.getState().status,
    getApiOrigin: () => this.settingsStore.getApiOrigin(),
    getCloudStatus: () => this.cloudStatus,
  });
  private readonly cloudSocketStartup = new CloudSocketStartupCoordinator();
  private cloudCommandsPaused: boolean;
  // In-memory dashboard capture verdict. refreshTrayState() consults this so
  // the degraded indicator sticks across later refreshes instead of being reset
  // to ready by the next cloud heartbeat or gateway recheck. Not persisted; a
  // fresh boot re-attempts the dashboard listener, so the verdict is per-process.
  private agentMonitorFailed = false;
  private agentMonitorFailureReason: string | null = null;
  // ISS-4714: the first-class Agent Monitor runtime status surfaced to the
  // renderer (`desktop:get-runtime-status`). Starts "starting" and advances to
  // "ready" once the local DB runtime is up, or "failed" (with `dbAhead` set for
  // the DB-created-by-a-newer-build case) so the renderer can show a prominent
  // "update required" state instead of pretending sync is healthy.
  private agentMonitorRuntimeStatus: AgentMonitorRuntimeStatus =
    STARTING_AGENT_MONITOR_RUNTIME_STATUS;
  /**
   * ISS-4711 / boot yielding: the renderer readiness signals (first data
   * served, first live-DB idle, first collector import) and the renderer
   * activity quiet window that background boot work yields to. ISS-5346 adds
   * the initial window reveal as a consumer.
   */
  private readonly rendererGates = new RendererReadinessGates({
    info: (scope, message) => gatewayLog.info(scope, message),
    warn: (scope, message) => gatewayLog.warn(scope, message),
  });
  private cloudConnectionEnabled: boolean;
  private readonly sessionMesh = createDesktopSessionMeshController({
    userDataPath: () => app.getPath("userData"),
    isEnabled: () => !(this.goldenMode || this.shuttingDown),
    sessionManager: () => this.desktopSessionManager,
    computeTargetId: () => this.sessionSyncIdentity.computeTargetId(),
    getApiOrigin: () => this.settingsStore.getApiOrigin(),
    log: (message) => gatewayLog.warn("session-mesh", message),
  });
  private readonly sessionSyncCapabilities =
    createNegotiatedSessionSyncCapabilities(this.sessionSyncIdentity);
  /**
   * FEA-3425 (Phase 3): the Code plugin version, read once (a `readFileSync` of
   * the plugin registry) and reused for every write-lane request's
   * `x-desktop-plugin-version` header — matching the socket path, which reads it
   * once at hello-handshake construction (`cloud-socket.ts` `pluginVersion`).
   * This is NOT the Electron app version; that travels as `desktop_client_version`.
   */
  private readonly cachedCodePluginVersion = getCodePluginVersion();
  /**
   * FEA-3425 (Phase 3): the best-effort observability write lanes (product
   * analytics + diagnostics telemetry) and their authenticated HTTP twins,
   * owned by one collaborator instead of accreting onto this class. HTTP-only
   * since Phase 4a (the relay-socket fallback was retired). Field initializer is
   * safe: every accessor is a lazy lambda that only runs at send/flush time,
   * after the constructor has assigned the session manager and settings store.
   */
  private readonly observabilityLaneRouter = createObservabilityLaneRouter({
    getIdentity: () => this.desktopSessionManager.getIdentity(),
    getAppVersion: () => app.getVersion(),
    getAccessToken: () => this.desktopSessionManager.getAccessToken(),
    getApiOrigin: () => this.settingsStore.getApiOrigin(),
    getPluginVersion: () => this.cachedCodePluginVersion,
    onUnauthorized: () => this.desktopSessionManager.invalidateAccessToken(),
    reportAuthFailure: (input) => this.reportAuthFailure(input),
    // ISS-8687: strict-online still gates every other analytics event and the
    // whole telemetry twin; only the offline-deliverable family reads the
    // retained id. Bundled so the three reads cannot disagree.
    ...this.sessionSyncIdentity.observabilityLaneIdentity(),
    // ISS-10503 (PRD-736 D5): the pre-auth identity reads (factory owns why).
    ...createPreAuthAnalyticsIdentityReads({
      getAuthStatus: () => this.desktopSessionManager.getState().status,
      getNodeUuid: () => this.getNodeUuidForTelemetry(),
      getOperatingMode: () =>
        getDesktopAppOperatingModeForTelemetry(this.apiKeyStore),
    }),
  });
  /**
   * ISS-7710: defers the connect-time observability emission out of `onHelloAck`
   * and into the applied-online status branch, where the lane router's send gate
   * is actually open. See `connection-lifecycle-reporter.ts` for why the
   * handshake ordering itself must not move.
   */
  private readonly connectionLifecycle = createConnectionLifecycleReporter();
  private updateCheckTimer: NodeJS.Timeout | null = null;
  private readonly startUpdateChecks: () => void;
  private packagedUpdateState: PackagedUpdateState =
    createInitialPackagedUpdateState();
  private applyingDownloadedUpdate = false;
  private readonly updateBlockedController: UpdateBlockedController =
    new UpdateBlockedController({
      getPackagedUpdateState: () => this.packagedUpdateState,
      setPackagedUpdateState: (patch) => this.setPackagedUpdateState(patch),
      notifyPackagedUpdateStatus: () => this.notifyPackagedUpdateStatus(),
      telemetry: {
        updateFailed: (input) => Observability.electronUpdateFailed(input),
      },
      platform: {
        showMessageBox: (options) => dialog.showMessageBox(options),
        showErrorBox: (title, content) => dialog.showErrorBox(title, content),
        // Overwrite a stale copy in /Applications, but never one that is
        // currently running.
        moveToApplicationsFolder: () =>
          app.moveToApplicationsFolder({
            conflictHandler: (conflictType) => conflictType === "exists",
          }),
      },
    });
  private readonly queueStatsTelemetryDebounce: QueueStatsDebounce =
    createQueueStatsDebounce(
      (active, depth) => Observability.queueStatsChanged(active, depth),
      QUEUE_STATS_DEBOUNCE_MS
    );
  constructor(options?: DesktopApplicationOptions, services?: DesktopServices) {
    this.goldenMode = options?.golden ?? null;
    this.gatewayAuthToken = randomBytes(24).toString("hex");
    // PLN-1359 Phase 2: collaborators are wired by the composition root rather
    // than hand-built here, so a test can inject a fake bag. The real path builds
    // them from this application as the host; every host callback is lazy, so it
    // may reach services and fields assigned further down — exactly what the
    // previous inline `() => this.x` arrows relied on.
    const wired =
      services ??
      createDesktopApplicationServices(options, this.createServicesHost());
    this.sessionStore = wired.sessionStore;
    this.settingsStore = wired.settingsStore;
    this.apiKeyStore = wired.apiKeyStore;
    this.nodeUuidStore = wired.nodeUuidStore;
    this.appOtelRuntime = wired.appOtelRuntime;
    this.reportAuthFailure = wired.reportAuthFailure;
    this.telemetryOrgProvider = wired.telemetryOrgProvider;
    this.appLifecycleTelemetry = wired.appLifecycleTelemetry;
    this.updateTelemetry = createDesktopUpdateLifecycleReporter({
      getCurrentVersion: () => app.getVersion(),
      emit: (input) => this.appOtelRuntime.emitUpdateEvent(input),
      store: createUpdateTelemetryStore(app.getPath("userData")),
      isTelemetryLive: () => this.appOtelRuntimeStarted,
    });
    // Wiring above does not mutate these freshly constructed settings.
    this.cloudCommandsPaused = this.settingsStore.getCloudCommandsPaused();
    this.cloudConnectionEnabled =
      this.settingsStore.getCloudConnectionEnabled();
    this.gatewaySigningKeyStore = wired.gatewaySigningKeyStore;
    this.desktopSessionStore = wired.desktopSessionStore;
    this.desktopSessionManager = wired.desktopSessionManager;
    this.realtimeHost = wired.realtimeHost;
    this.credentialStore = new DesktopCredentialStoreAdapter({
      settingsStore: this.settingsStore,
      apiKeyStore: this.apiKeyStore,
      gatewaySigningKeyStore: this.gatewaySigningKeyStore,
      getActiveGatewayId: () => this.getActiveGatewayId(),
      getDesktopVersion: () => app.getVersion(),
      getMachineName: () => resolveDesktopMachineName(),
      getPlatform: () => process.platform,
    });
    this.tray = wired.tray;
    this.desktopWindow = wired.desktopWindow;
    this.activityLog = wired.activityLog;
    this.approvalStore = wired.approvalStore;
    // PLN-1359 Phase 3: approval decisioning lives in its own collaborator; the
    // application only supplies the onboarding gate and the debug auto-approve
    // flag it still owns.
    this.approvalEvaluator = new ApprovalEvaluator({
      settingsStore: this.settingsStore,
      approvalStore: this.approvalStore,
      isDesktopSetupComplete: () => this.isDesktopSetupComplete(),
      isDangerousAutoApprove: () => this.dangerousAutoApprove,
    });
    this.managedOnboarding = new ManagedOnboardingController({
      settingsStore: this.settingsStore,
      apiKeyStore: this.apiKeyStore,
      desktopSessionManager: this.desktopSessionManager,
      getAccountAdmission: () => this.currentAccountAdmission(),
      isCredentialMutationAllowed: () =>
        !this.settingsStore.getSignOutCleanupState().isPending(),
      mayCommitManagedKey: (captured) =>
        this.signOutLoopCleanup.mayCommitManagedKey(
          captured,
          this.desktopSessionManager.getAccountAdmission()
        ),
      gatewaySigningKeyStore: this.gatewaySigningKeyStore,
      telemetryOrgProvider: this.telemetryOrgProvider,
      desktopWindow: this.desktopWindow,
      isShuttingDown: () => this.shuttingDown,
      showWindow: () => this.showWindow(),
      getActiveGatewayId: () => this.getActiveGatewayId(),
      resolveDesktopDeviceDescriptor: () =>
        this.credentialStore.resolveDeviceDescriptor(),
      reportDesktopPopUnavailable: (surface, reason) =>
        this.reportDesktopPopUnavailable(surface, reason),
      signDesktopRequest: (request) => this.signDesktopRequest(request),
      persistActiveProfileKey: (apiKey, provenance) =>
        this.credentialStore.persistActiveProfileKey(apiKey, provenance),
      persistActiveConfigManagedMetadata: (patch) =>
        this.credentialStore.persistManagedMetadata(patch),
      reportBootstrapClaimDiagnostic: (diagnostic) =>
        this.reportBootstrapClaimDiagnostic(diagnostic),
      restartCloudSocket: () => this.restartCloudSocket(),
      isDesktopSetupComplete: () => this.isDesktopSetupComplete(),
      registerOpenFileHandler: (onOpenFile) => {
        app.on("open-file", (event, filePath) => {
          event.preventDefault();
          onOpenFile(filePath);
        });
      },
      showMessageBox: (options) => dialog.showMessageBox(options),
      openExternalUrl: (url) => shell.openExternal(url),
    });
    this.gatewayIdentity = new GatewayIdentityStore(app.getPath("userData"));
    this.gatewayIdentity.loadSync();
    this.server = DesktopGatewayServer.createDefault(
      this.settingsStore.getWebAppOrigin(),
      () => (this.isNoAuthMode() ? undefined : this.gatewayAuthToken),
      () => this.getAllowedDirectoriesFromSandbox(),
      resolveDesktopMachineName(),
      app.getVersion(),
      EMPTY_CAPABILITIES,
      (event) => {
        this.activityLog.add(event);
      },
      (request) => this.approvalEvaluator.evaluate(request),
      () => this.getSymphonyDir(),
      this.sessionStore,
      () => this.settingsStore.getApiOrigin(),
      () => this.settingsStore.getWebAppOrigin(),
      this.isProdOriginsOnly(),
      () => this.recovery.onUnexpectedClose(),
      () => this.getActiveGatewayId(),
      () => this.settingsStore.getBinaryPaths(),
      (patch) => this.applyBinaryPathPatchAndInvalidateCaches(patch),
      () => this.onlineComputeTargetId(),
      (payload) => this.handleSecurityUpgradeCommand(payload),
      () => this.isDesktopSetupComplete(),
      createGatewayPackInstaller(() => this.agentDashboardDesignSystem),
      this.desktopSessionManager
    );
    this.commandExecutor = new CloudCommandExecutor({
      getGatewayPort: () => this.server.getActivePort(),
      getGatewayAuthToken: () => this.gatewayAuthToken,
      maxInFlightCommands: MAX_IN_FLIGHT_COMMANDS,
      sendCommandAck: (event) => this.cloudSocket.sendCommandAck(event),
      sendCommandEvent: (event) => this.cloudSocket.sendCommandEvent(event),
      onQueueStatsChange: (stats) => {
        this.cloudSocket.sendPresence(
          buildPausedAwarePresence({
            cloudOnline: this.cloudStatus.state === "online",
            paused: this.cloudCommandsPaused,
            gatewayHealthy: this.recovery.gatewayHealthy,
            activeCommands: stats.activeCommands,
            queueDepth: stats.queueDepth,
          })
        );
        this.queueStatsTelemetryDebounce.trigger(stats);
      },
    });
    this.cloudSocket = new CloudSocketService({
      getAccountAdmission: () => this.currentAccountAdmission(),
      getRelayOrigin: () => this.settingsStore.getRelayOrigin(),
      getApiKey: () => this.apiKeyStore.getApiKey(),
      getApiKeyDiagnostic: () => this.apiKeyStore.getApiKeyDiagnostic(),
      getApiKeyProvenance: () => this.apiKeyStore.getApiKeyProvenance(),
      signDesktopRequest: (request) => this.signDesktopRequest(request),
      onDesktopPopUnavailable: (surface, reason) =>
        this.reportDesktopPopUnavailable(surface, reason),
      getAllowedDirectories: () => this.getAllowedDirectoriesFromSandbox(),
      getCapabilities: () => ({ ...EMPTY_CAPABILITIES }),
      getMaxInFlightCommands: () => MAX_IN_FLIGHT_COMMANDS,
      getGatewayId: () => this.credentialStore.getUpgradeCapableGatewayId(),
      getCommandWorkStats: () => this.commandExecutor.getStats(),
      machineName: resolveDesktopMachineName(),
      pluginVersion: getCodePluginVersion(),
      desktopClientVersion: app.getVersion(),
      gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      getEnabledOperations: () => [...SUPPORTED_OPERATION_IDS],
      reportAuthFailure: (input) => this.reportAuthFailure(input),
      onStatusChange: (status) => this.onCloudSocketStatus(status),
      onDisconnect: (reason) => {
        refreshDesktopSyncWriteLanes(this.syncLanes);
        this.connectionLifecycle.reportLost(reason);
      },
      onHelloAck: (event) => {
        this.sessionSyncCapabilities.recordHelloAck(
          event.computeTargetId,
          event.serverCapabilities
        );
        this.connectionLifecycle.recordHelloAck(event);
        if (event.resumeFromSequence) {
          this.commandExecutor.replayFrom(event.resumeFromSequence);
        }
        /*
         * ISS-7710: the connection events are emitted from the applied-online
         * branch of `onCloudSocketStatus`, not here. `CloudSocketService` calls
         * this handler BEFORE `notifyStatus({ state: "online" })`, and the
         * observability lane router gates every send on that applied status, so
         * an emission made here is always dropped.
         */
        refreshDesktopSyncWriteLanes(this.syncLanes);
      },
      onCommand: (command) => {
        admitInboundCloudCommand(command, {
          sendCommandAck: (event) => this.cloudSocket.sendCommandAck(event),
          handleGitHubResyncNudgeCommand: (nudge) => {
            void this.handleGitHubResyncNudgeCommand(nudge);
          },
          isDesktopSetupComplete: () => this.isDesktopSetupComplete(),
          areCloudCommandsPaused: () => this.cloudCommandsPaused,
          enqueue: (accepted) => this.commandExecutor.enqueue(accepted),
        });
      },
      onCancel: (event) => {
        this.commandExecutor.cancel(event);
      },
      onCommandEventAck: (event) => {
        this.commandExecutor.acknowledge(event);
      },
    });
    // FEA-4169 / FEA-3425: cloud lanes share the first-party session Bearer
    // transport and remain inert until their live gates open.
    const syncLanes = createDesktopSyncLanes(
      buildDesktopSyncLaneDeps({
        computeTargetLinkBlock: this.computeTargetLinkBlock.tracker,
        desktopSessionManager: this.desktopSessionManager,
        settings: this.settingsStore,
        sessionSyncIdentity: this.sessionSyncIdentity,
        syncEgressGate: this.syncEgressGate,
        rendererGates: this.rendererGates,
        appOtelRuntime: this.appOtelRuntime,
        getApiKey: () => this.apiKeyStore.getApiKey(),
        getServerCapabilities: () => this.sessionSyncCapabilities.current(),
        getTranscriptComputeTargetId: () => this.onlineComputeTargetId(),
        getDashboardRuntime: () => this.agentDashboardDesignSystem,
        getTranscriptSync: () => this.transcriptSync,
      })
    );
    this.agentSessionSync = syncLanes.agentSessionSync;
    this.agentComponentInvocationSync = syncLanes.agentComponentInvocationSync;
    this.syncLanes = syncLanes;
    this.syncBurndownReporter = syncLanes.syncBurndownReporter;
    this.wireAuthSessionSubscriptions();
    // FEA-2923 (T-16.8/10): auto-install required plugin distributions on cloud
    // online transition. Uses the first-party Desktop session for auth and
    // the existing streamRun catalog path for installs (unchanged trust model).
    this.requiredPluginInstaller = new RequiredPluginInstaller(
      buildRequiredPluginInstallerOptions({
        getAccessToken: () => this.desktopSessionManager.getAccessToken(),
        getApiOrigin: () => this.settingsStore.getApiOrigin(),
        getDesignSystemRuntime: () => this.agentDashboardDesignSystem,
        // ISS-4428: null (skip retry) after disposal or while offline.
        resolveRuntimeReadyTarget: () =>
          this.shuttingDown ? null : this.onlineComputeTargetId(),
        // Coaching packs (batch 5) install via the coaching-pack path — download
        // the presigned asset zip, extract it, and copy/activate through
        // installCoachingPackFromDistribution honoring override precedence.
        installCoachingDistribution: (dist) =>
          this.coachingPacks.installDistribution(dist),
        getWindow: () => this.desktopWindow,
        // FEA-4050 declines plus the ISS-6170 closed-by-default Labs gate on the
        // give-up notification; the module narrows this to those three members.
        settings: this.settingsStore,
        createNotification: (options) => new Notification(options),
      })
    );
    // FEA-3932: register the materialized OpenCode root as a trusted transcript
    // path root UNCONDITIONALLY — independent of the upload-consent/sync gate.
    // The always-on local read bridge (`getLocalTranscriptPath`) must be able to
    // trust a persisted OpenCode projection even when sync is currently disabled
    // (e.g. sync ran once, materialized files, then the user turned sync off);
    // gating this behind sync construction would leave those files un-trusted and
    // the read fallback broken. Leaf module; no collector import.
    setMaterializedOpencodeTranscriptRoot(
      path.join(
        resolveDesktopTranscriptStateDir(),
        "transcript-materialized",
        "opencode"
      )
    );
    // FEA-2715: raw-transcript archive lane, off unless the desktop feature flag
    // is on (restart-scoped). Constructed here so it is a hard no-op when off.
    this.transcriptSync = this.settingsStore.getTranscriptSyncEnabled()
      ? this.createTranscriptSyncService()
      : null;
    // Cost reconciliation + Claude Code analytics are wired by the composition
    // root (they couple only to loadAgentDashboardMeteredUsageRows via the host).
    this.costReconciliation = wired.costReconciliation;
    this.claudeCodeAnalytics = wired.claudeCodeAnalytics;
    this.recovery = new GatewayRecoveryManager({
      probe: () => this.probeGatewayAlive(),
      restart: () => this.server.restart(),
      getCloudStatus: () => this.cloudStatus,
      setConnected: (connected) => this.commandExecutor.setConnected(connected),
      sendPresence: (state, error) => {
        const stats = this.commandExecutor.getStats();
        this.cloudSocket.sendPresence({
          state,
          ...(error ? { error } : {}),
          activeCommands: stats.activeCommands,
          queueDepth: stats.queueDepth,
        });
      },
      refreshTray: (detail) => this.refreshTrayState(detail),
      log: (level, msg) => gatewayLog[level]("gateway-recovery", msg),
      isShuttingDown: () => this.shuttingDown,
      isPaused: () => this.cloudCommandsPaused,
    });
    this.signOutLoopCleanup = new SignOutLoopCleanup({
      settingsStore: this.settingsStore,
      apiKeyStore: this.apiKeyStore,
      desktopSessionStore: this.desktopSessionStore,
      rotateLegacyGatewayIdentity: () => this.gatewayIdentity.rotateSync(),
      log: (message) => gatewayLog.warn("sign-out-cleanup", message),
    });
    const { UpdateAvailable, UpdateStatus } = DesktopRendererEventChannel;
    // ISS-10291: the IPC below can check before boot starts the checks.
    this.startUpdateChecks = installDesktopUpdateLane({
      getPackagedUpdateState: () => this.packagedUpdateState,
      setPackagedUpdateState: (patch) => this.setPackagedUpdateState(patch),
      notifyPackagedUpdateStatus: () => this.notifyPackagedUpdateStatus(),
      handleUpdateInstallBlocked: (version) =>
        this.updateBlockedController.handleUpdateInstallBlocked(version),
      guardUpdateDownload: (result) => this.guardUpdateDownload(result),
      sendUpdateAvailableToRenderer: (payload) =>
        this.desktopWindow.sendToRenderer(UpdateAvailable, payload),
      checkForUpdate: () => this.checkForUpdate(),
      getComputeTargetId: () => this.updaterComputeTargetId(),
      notifyRendererDevUpdateReady: () =>
        this.desktopWindow.sendToRenderer(
          UpdateStatus,
          DEV_UPDATE_READY_STATUS
        ),
      getUpdateCheckTimer: () => this.updateCheckTimer,
      setUpdateCheckTimer: (timer) => {
        this.updateCheckTimer = timer;
      },
      updateTelemetry: this.updateTelemetry,
    });
    this.registerIpcHandlers();
    this.managedOnboarding.registerOnboardingFileOpenHandler();
  }
  /** Compose lazy callbacks after all application services are assigned. */
  private createServicesHost(): DesktopServicesHost {
    return {
      beginSignInAnalytics: this.observabilityLaneRouter.beginSignInAnalytics,
      onRendererNavigationReady: () => this.notifyPackagedUpdateStatus(),
      sendProductAnalytics: this.observabilityLaneRouter.sendAnalytics,
      flushProductAnalytics: this.observabilityLaneRouter.flushAnalytics,
      sendDesktopTelemetry: this.observabilityLaneRouter.sendTelemetry,
      flushDesktopTelemetry: this.observabilityLaneRouter.flushTelemetry,
      getActiveGatewayId: () => this.getActiveGatewayId(),
      getNodeUuidForTelemetry: () => this.getNodeUuidForTelemetry(),
      getAppOperatingModeForTelemetry: () =>
        getDesktopAppOperatingModeForTelemetry(this.apiKeyStore),
      getAgentMonitorRuntimeStatusKindForTelemetry: () =>
        resolveCaptureLivenessStatus(
          this.agentMonitorRuntimeStatus,
          this.agentMonitorFailed
        ),
      signDesktopRequest: (request) => this.signDesktopRequest(request),
      resolveDesktopDeviceDescriptor: () =>
        this.credentialStore.resolveDeviceDescriptor(),
      publishDesktopAuthState: (state) =>
        this.desktopWindow.sendToRenderer(
          DESKTOP_AUTH_STATE_CHANGED_CHANNEL,
          state
        ),
      getDesktopAccountAdmission: () => this.currentAccountAdmission(),
      onDesktopAccountChanged: (admission) =>
        reconcileDesktopAccountChange(admission, {
          clearOrgDirectory: clearOrgDirectoryCache,
          stopCloud: () => {
            this.cloudSocketStartup.invalidate();
            this.cloudSocket.stop();
            this.onCloudSocketStatus({ state: CloudSocketState.Idle });
          },
          realtime: this.realtimeHost,
          forgetSessionSyncIdentity: () => this.sessionSyncIdentity.forget(),
          mayRestartCloud: () =>
            this.cloudConnectionEnabled &&
            Boolean(this.apiKeyStore.getApiKey()),
          restartCloud: () => this.restartCloudSocket(),
        }),
      maybeAutoProvisionManagedKey: () =>
        this.managedOnboarding.maybeAutoProvisionManagedKey(),
      loadAgentDashboardMeteredUsageRows: () =>
        this.loadAgentDashboardMeteredUsageRows(),
      rendererGates: this.rendererGates,
    };
  }

  // Reserved for FEA-1983 telemetry bootstrap to read app.installation.id
  // from the main-process owner without duplicating store access.
  getNodeUuidForTelemetry(): string {
    return this.nodeUuidStore.getOrCreateNodeUuid();
  }

  async boot(): Promise<void> {
    gatewayLog.setVerbose(this.settingsStore.getAll().verboseLogging);
    this.appOtelRuntimeStarted = await startDesktopOtelRuntimeForBoot({
      runtime: this.appOtelRuntime,
      logWarning: (tag, message) => gatewayLog.warn(tag, message),
    });
    this.appLifecycleTelemetry.start();
    // ISS-7247: settle any upgrade attempt that asked for this restart. Runs
    // AFTER the lifecycle start above so the `app.lifecycle.event:start` that
    // reports the version actually running is already on the wire when the
    // terminal update record referring to it lands.
    this.updateTelemetry.onBoot();
    // Resolve the org up front (when authenticated) so the first heartbeat
    // carries it rather than waiting for the lazy emit-path resolution.
    this.telemetryOrgProvider.warm();
    gatewayLog.info("startup", describeDesktopBootIdentity());

    if (process.platform === "darwin" && app.dock) {
      const dockIcon = nativeImage.createFromPath(
        path.join(resolveResourcesDir(), "icon-1024.png")
      );
      app.dock.setIcon(dockIcon);
    }

    this.tray.init({
      onOpen: () => this.showWindow(),
      onOpenClaudeDashboard: () => this.openClaudeDashboard(),
      onTogglePaused: (paused) => this.setCloudCommandsPaused(paused),
    });
    this.tray.setPaused(this.cloudCommandsPaused);
    this.syncPendingApprovalsToTray();
    this.registerDisabledAgentDashboardDbIpcHandlers();
    this.desktopWindow.init();
    await this.signOutLoopCleanup.resumeIfPending().catch((error) => {
      gatewayLog.warn(
        "sign-out-cleanup",
        `Pending cleanup remains active: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    if (this.settingsStore.getSignOutCleanupState().isPending()) {
      this.desktopSessionManager.signOut().catch(() => undefined);
    } else {
      this.desktopSessionManager.restore().catch((error) => {
        gatewayLog.warn(
          "desktop-auth",
          `Session restore failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
    this.managedOnboarding.markBootReadyForOnboarding();
    void this.managedOnboarding.drainQueuedOnboardingHandoffs();
    void this.managedOnboarding.processCanonicalOnboardingHandoff("cold-start");
    void this.managedOnboarding.maybeShowOnboardingPopup();

    void this.seedPreviousSessionLogTail();
    deleteRetiredStoreFiles(app.getPath("userData"), (message) =>
      gatewayLog.warn("retired-store-files", message)
    );
    deleteRetiredHomeFiles(app.getPath("home"), (message) =>
      gatewayLog.warn("retired-store-files", message)
    );
    const bootSandbox = this.settingsStore.getSandboxBaseDirectory();
    this.schedulePostInitialWindowBootTasks(bootSandbox);
    // Unconditional and NOT inside the call above: the lanes must never wait on
    // the window being revealed. See startSyncLanesAtBoot.
    this.startSyncLanesAtBoot();

    // FEA-1435/1436: schedule nightly cost reconciliation. Independent of the
    // Agent Monitor toggle — the scheduled tick no-ops unless a vendor Admin key
    // is configured, and loadUsageRows returns [] when the selected dashboard
    // source is disabled or has no metered rows in the window.
    this.costReconciliation.start();

    try {
      await this.server.start();
      const configuredOrigins = {
        relayOrigin: this.settingsStore.getRelayOrigin(),
        apiOrigin: this.settingsStore.getApiOrigin(),
        webAppOrigin: this.settingsStore.getWebAppOrigin(),
      };
      this.refreshTrayState(
        `Serving on localhost:${this.server.getActivePort()} | relay=${configuredOrigins.relayOrigin} api=${configuredOrigins.apiOrigin} web=${configuredOrigins.webAppOrigin}`
      );
      if (this.goldenMode) {
        this.cloudStatus = {
          state: "disabled",
          reason: "Golden mode: cloud sync disabled",
        };
      } else if (this.cloudConnectionEnabled) {
        this.scheduleCloudSocketStartAfterInitialUi();
      } else {
        this.cloudStatus = CLOUD_DISABLED_BY_USER_STATUS;
      }
      this.startUpdateChecks();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown startup error";
      this.tray.setState("error", `Desktop startup failed: ${message}`);
      throw error;
    }
  }

  showWindow(intent: WindowShowIntent = WindowShowIntent.UserRequested): void {
    this.desktopWindow.init();
    this.desktopWindow.show(intent);
  }

  private async seedPreviousSessionLogTail(): Promise<void> {
    try {
      const previousLogEntries = await readPreviousSessionLogTail(200);
      gatewayLog.seedPreviousSessionEntries(previousLogEntries);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown log tail error";
      gatewayLog.warn(
        "persistent-log",
        `Unable to seed previous log tail: ${message}`
      );
    }
  }

  private schedulePostInitialWindowBootTasks(bootSandbox: string | null): void {
    let started = false;
    const start = async (): Promise<void> => {
      if (started || this.shuttingDown) {
        return;
      }

      started = true;
      await yieldToMainLoop();
      if (this.shuttingDown) {
        return;
      }

      if (bootSandbox?.trim()) {
        void seedReposConfig(bootSandbox);
      }
      await yieldToMainLoop();
      if (this.shuttingDown) {
        return;
      }

      void this.startAgentCapture().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        gatewayLog.warn(
          "agent-monitor",
          `Agent Monitor capture failed after boot: ${message}`
        );
      });
      // Start the session-limit producers (FEA-3492/3523, PRD-538 R5). Kept out
      // of startAgentCapture() so they do not ride on the Agent Dashboard SQLite
      // runtime succeeding; each is best-effort and never throws into boot. See
      // session-limits/session-limits-boot.ts for the golden-mode rule.
      this.sessionLimitsBoot ??= new SessionLimitsBoot({
        isGoldenMode: () => this.goldenMode !== null,
        isUsageCaptureEnabled: () =>
          this.sessionLimitsGate.isUsageCaptureEnabled(),
      });
      // Never rejects; the promise only reports that the lazily-loaded
      // statusline half has been attempted, which boot does not wait on.
      this.sessionLimitsGate.reconcile().catch(() => undefined);
    };

    // ISS-5990: the reveal is the FAST PATH, no longer the requirement. This is
    // the only boot route to `startAgentCapture()` and so to a non-null
    // `getSyncSource()`; behind a raw `whenInitiallyShown()` a headless boot ran
    // four lanes against null forever. See boot-admission-deadline.ts.
    scheduleAfterBootAdmission(
      () => this.desktopWindow.whenInitiallyShown(),
      start
    );
  }

  /**
   * Start the desktop→cloud sync lanes. `main/sync/AGENTS.md` invariant 9: one
   * direct, unconditional call, on the boot path, behind nothing.
   *
   * ISS-4717 deleted the INNER `whenInitialCollectorImportComplete()` gate; this
   * method exists because that was not sufficient — the call still sat in
   * `schedulePostInitialWindowBootTasks`'s window-deferred `start()` closure
   * (codex, PR #4665). Keep it here and unconditional: that method's contract is
   * "defer so heavy work does not contend with first paint", right for the
   * collector import and wrong for the lanes.
   *
   * The lanes' only real prerequisite is the agent DB runtime, satisfied lazily,
   * NOT by ordering — the lane's source may resolve null, a null pass consumes
   * no budget, and its own tick retries (5s). Lazy too
   * (`desktopSessionManager.subscribe` + the org-policy subscription re-kick
   * `refresh()`, both wired in the constructor). Starting earlier only widens the
   * window in which work is picked up.
   *
   * ISS-5990: lazily is only eventually if runtime composition itself is not
   * renderer-gated. It was, so a headless boot ran these lanes against a null
   * source forever — see `lifecycle/boot-admission-deadline.ts`.
   */
  private startSyncLanesAtBoot(): void {
    this.startAgentSessionSync({});
  }

  private startAgentSessionSync(options: {
    historicalBackfill?: boolean;
  }): void {
    if (this.shuttingDown) {
      return;
    }
    startDesktopSyncLanes(this.syncLanes, options);
    // FEA-2715: the transcript lane shares the local DB (agent-dashboard runtime)
    // so it starts alongside the metadata lane. Idempotent + a no-op when the
    // feature flag is off. Its own 5s tick self-heals connectivity changes.
    this.transcriptSync?.start();
  }

  private scheduleCloudSocketStartAfterInitialUi(): void {
    if (this.goldenMode) {
      return;
    }
    void this.cloudSocketStartup
      .startAfterInitialUi({
        isCloudConnectionEnabled: () => this.cloudConnectionEnabled,
        isShuttingDown: () => this.shuttingDown,
        startCloudSocket: () => this.cloudSocket.start(),
        waitForWindowReveal: () => this.desktopWindow.whenInitiallyShown(),
        waitForInitialUi: () =>
          this.rendererGates.waitForDashboardReadinessBeforeCloudSocket(),
        yieldToMainLoop,
      })
      .catch(logCloudSocketStartupFailure);
  }

  async handleActivate(): Promise<void> {
    // ISS-5346: `activate` is also the macOS cold launch; see WindowShowIntent.
    this.showWindow(WindowShowIntent.AppActivated);
    await this.managedOnboarding.processCanonicalOnboardingHandoff("activate");
  }

  /** Keep the saved profile identity stable only while account work may run. */
  private getActiveGatewayId(): string {
    return resolveActiveGatewayId(
      this.settingsStore,
      this.desktopSessionManager.getState().status,
      this.desktopSessionStore.hasSession(),
      this.gatewayIdentity.currentSync()
    );
  }

  /** Reports setup completion for first-run onboarding and already-provisioned profiles. */
  private isDesktopSetupComplete(): boolean {
    return isDesktopSetupCompleteFromState({
      onboardingCompleted: this.settingsStore.getOnboardingCompleted(),
      sandboxBaseDirectory: this.settingsStore.getSandboxBaseDirectory(),
      hasApiKey: this.apiKeyStore.getApiKey() !== null,
    });
  }

  // A bound arrow rather than a method: two option bags hand it out verbatim.
  private readonly getCloudReadComputeTargetId = (): string | null =>
    this.sessionSyncIdentity.cloudReadComputeTargetId(
      this.settingsStore.getActiveConfig()
    );

  private onlineComputeTargetId(): string | null {
    return this.sessionSyncIdentity.onlineComputeTargetId();
  }

  /**
   * ISS-9164: the ring identity every updater request is stamped with. Held in
   * one place because three seams supply it — the boot/poll lane, the gateway
   * update action, and the renderer's update IPC — and a check that resolved it
   * from a different accessor would stamp a different ring than the poll beside
   * it. Auth-gated on purpose: the updater feed is unauthenticated, so it must
   * never carry a signed-out install's prior target (whitlockk, #6867).
   */
  private updaterComputeTargetId(): string | null {
    return this.sessionSyncIdentity.authenticatedComputeTargetId();
  }

  /**
   * ISS-5348 / ISS-11449: the session-data egress gate, bound to the live stores.
   * The pure decision — the per-device consent tier, since the outer org policy
   * was retired — lives in `sync-egress-gate.ts`; the store binding lives in
   * `sync-egress-gate-adapter.ts`. Both halves are out of this grandfathered file
   * on purpose.
   */
  private readonly syncEgressGate = createSyncEgressGateAdapter({
    getConsentRecord: () => this.settingsStore.getSyncConsentRecord(),
    getSessionOrganizationId: () =>
      this.desktopSessionManager.getState().organizationId,
  });

  /**
   * ISS-9418 / ISS-8610: wire the auth-session-change reaction. The identity diff
   * and shutdown gating live in auth-session-lane-recovery.ts, what each seam
   * kicks in sync-lane-kicks.ts; this only points them at the lanes.
   */
  private wireAuthSessionSubscriptions(): void {
    this.authSessionLaneRecovery = wireAuthSessionLaneRecovery({
      isShuttingDown: () => this.shuttingDown,
      getAccountIdentity: () => this.desktopSessionManager.getIdentity(),
      laneKicks: createAuthSessionLaneKicks({
        agentSessionSync: this.agentSessionSync,
        getTranscriptSync: () => this.transcriptSync,
      }),
    });
    this.desktopSessionManager.subscribe(() => {
      this.authSessionLaneRecovery?.onAuthSessionChange();
      this.agentSessionSync.refresh();
      this.observabilityLaneRouter.resetForSession();
    });
  }

  private createTranscriptSyncService(): TranscriptSyncService {
    return syncLaneFactories.createTranscriptSyncLane({
      desktopSessionManager: this.desktopSessionManager,
      settings: this.settingsStore,
      syncEgressGate: this.syncEgressGate,
      getAgentDashboardRuntime: () => this.agentDashboardDesignSystem,
      // ISS-11467: the identity-bound read, not the raw strict-online one. The
      // transcript archive lane carried 353 of the 24h `target_not_owned`
      // refusals against the session lane's 3, and the whole difference was that
      // this accessor never consulted the owner check. Bound through the shared
      // fold so this lane and its four siblings cannot disagree about what
      // "owned" means; null here is the state every consumer already reads as
      // "no identity yet".
      getComputeTargetId: () =>
        identityBoundComputeTargetId(
          this.onlineComputeTargetId(),
          this.sessionSyncIdentity.computeTargetId()
        ),
    });
  }

  /**
   * The coaching-pack slice — flag gates, packs directory, seed-once bundled
   * copy, and distribution install. The whole slice lives in
   * `packs/coaching-pack-controller.ts`; this only binds it to the live stores.
   */
  private readonly coachingPacks = createCoachingPackController({
    getFlag: (key) => this.settingsStore.getFlag(key),
    getUserDataDir: () => app.getPath("userData"),
  });

  private getAgentMonitorUrl(): string | null {
    return this.agentDashboardDesignSystem?.getUrl() ?? null;
  }

  private isAgentMonitorReady(): boolean {
    return this.agentDashboardDesignSystem?.isReady() ?? false;
  }

  private isLocalSessionSourceReady(): boolean {
    return this.agentDashboardDesignSystem !== null;
  }

  private getLocalSessionSourceStatus() {
    // The Sessions list reads from local SQLite IPC; it does not depend on the
    // hook listener/OTLP endpoint being bound. `isAgentMonitorReady()` continues
    // to describe capture endpoint readiness for the legacy `ready` field, while
    // this source status should unblock reads as soon as the DB runtime exists.
    if (this.isLocalSessionSourceReady()) {
      return LOCAL_SESSION_SOURCE_STATUSES.ready;
    }
    if (this.agentMonitorFailed) {
      return LOCAL_SESSION_SOURCE_STATUSES.unavailable;
    }
    return LOCAL_SESSION_SOURCE_STATUSES.starting;
  }

  private async loadAgentDashboardMeteredUsageRows(): Promise<
    MeteredUsageRow[]
  > {
    const cutoffIso = reconciliationCutoffIso(new Date());
    return await Promise.resolve(
      this.agentDashboardDesignSystem?.loadMeteredUsageRows(cutoffIso) ?? []
    );
  }

  private async ensureAgentDashboardDesignSystemRuntime(): Promise<AgentDashboardDesignSystemRuntime | null> {
    // ISS-4714: a boot-time DB failure is terminal; DB and DB IPC stay closed. Latch it so a
    // later caller (e.g. a branch-identity request) does not re-enter the init
    // try/catch below, which would re-run the doomed DB open AND re-emit the
    // one-per-boot app-exception telemetry event on every retry, inflating its
    // cardinality. The failure is surfaced once; further calls degrade to null.
    if (this.agentMonitorFailed) {
      return null;
    }
    if (!this.agentDashboardDesignSystem) {
      const result = await bootstrapAgentDashboardRuntime({
        onSessionMeshHookEvent: (event) => this.sessionMesh.handle(event),
        onSessionMeshReady: () => this.sessionMesh.start(),
        observeSyncBatch: this.computeTargetLinkBlock.observeSyncBatch,
        goldenMode: this.goldenMode,
        desktopWindow: this.desktopWindow,
        rendererGates: this.rendererGates,
        settingsStore: this.settingsStore,
        appOtelRuntime: this.appOtelRuntime,
        agentSessionSync: this.agentSessionSync,
        agentComponentInvocationSync: this.agentComponentInvocationSync,
        requiredPluginInstaller: this.requiredPluginInstaller,
        getTranscriptSync: () => this.transcriptSync,
        getApiKey: () => this.apiKeyStore.getApiKey(),
        getAccessToken: () => this.desktopSessionManager.getAccessToken(),
        getAccountAdmission: () => this.currentAccountAdmission(),
        isDesktopSessionSignedOut: () =>
          this.desktopSessionManager.isSignedOut(),
        getApiOrigin: () => this.settingsStore.getApiOrigin(),
        getCloudReadComputeTargetId: this.getCloudReadComputeTargetId,
        // ISS-8691 (whitlockk, #6351): the SAME accessor the session lane writes
        // under, not a second strict-online derivation of it. This one feeds
        // both the data-revision outbox ENQUEUE and the Sessions list's
        // pending-outbox READ, and both must key on whatever the lane actually
        // sent under — otherwise a batch pending under a retained target is
        // read back with a null target, which consults no outbox at all — so
        // (ISS-9004) the row discloses nothing instead of a false `synced`.
        getSyncComputeTargetId: () =>
          this.sessionSyncIdentity.computeTargetId(),
        getUserIdentity: () => this.apiKeyIdentityResolver.resolve(),
        // ISS-6243: the credential store sees a key set/rotated/cleared; the
        // resolver sees the cold-start `/me` landing. Both are needed.
        subscribeUserIdentityChanged: createUserIdentityChangeSubscription({
          apiKeyStore: this.apiKeyStore,
          identityResolver: this.apiKeyIdentityResolver,
        }),
        notifySessionTerminal: (notice) => this.notifySessionTerminal(notice),
        onTerminalFailure: (reason) => {
          new Notification({
            title: "Closedloop Agent Monitor",
            body: reason,
          }).show();
          this.agentMonitorFailed = true;
          this.agentMonitorFailureReason = reason;
          this.refreshTrayState();
        },
        refreshTrayState: () => this.refreshTrayState(),
        setAgentMonitorRuntimeStatus: (status) => {
          this.agentMonitorRuntimeStatus = status;
        },
        setAgentMonitorFailed: (reason) => {
          this.agentMonitorFailed = true;
          this.agentMonitorFailureReason = reason;
        },
        registerDisabledAgentDashboardDbIpcHandlers: () =>
          this.registerDisabledAgentDashboardDbIpcHandlers(),
        clearDisabledAgentDashboardDbIpcRegistered: () => {
          this.disabledAgentDashboardDbIpcRegistered = false;
        },
        configureOrgDirectoryPersistence: () => wireOrgDirectoryPersistence(),
        isShuttingDown: () => this.shuttingDown,
      });
      if (!result.ok) {
        return null;
      }
      this.agentDashboardDesignSystem = result.runtime;
      this.agentDashboardDesignSystem.registerIpcHandlers();
    }
    return this.agentDashboardDesignSystem;
  }

  /**
   * Start the Agent Dashboard capture stack — hooks and collectors. The DB
   * runtime may already exist for renderer IPC.
   *
   * ISS-4717: takes no options. The `startSessionSync` /
   * `historicalSessionBackfill` pair existed only to drive a sync-lane start
   * that no caller ever asked for, and both are gone with it; the lanes are
   * owned by `schedulePostInitialWindowBootTasks`.
   */
  private async startAgentCapture(): Promise<void> {
    const runtime = await this.ensureAgentDashboardDesignSystemRuntime();
    if (!runtime) {
      return;
    }
    await this.rendererGates.waitForInitialDashboardDataServedOrTimeout(
      "agent capture startup"
    );
    await this.rendererGates.waitForInitialRendererLiveDbIdleOrTimeout(
      "agent capture startup"
    );
    await this.rendererGates.waitForRendererBackgroundSlot();
    if (this.shuttingDown) {
      return;
    }
    if (!this.goldenMode) {
      // FEA-2648: golden mode must never write hook entries into the real
      // ~/.claude/settings.json or codex config — live capture stays off.
      syncAgentMonitorHooksOnBoot();
    }
    await this.rendererGates.waitForRendererBackgroundSlot();
    if (this.shuttingDown) {
      return;
    }
    this.sessionAnalysisConsent.startCollectorsWhenAgreed(runtime);
    // ISS-4717: sync lanes never wait for capture (main/sync/AGENTS.md invariant 9).
  }

  private async stopAgentCapture(
    options: { closeDesignSystem?: boolean } = {}
  ): Promise<void> {
    this.sessionMesh.stop();
    await this.agentDashboardDesignSystem?.stop();
    stopDesktopSyncLanes(this.syncLanes);
    this.transcriptSync?.stop();
    this.sessionAnalysisConsent.dispose();
    this.sessionLimitsGate.dispose();
    this.sessionLimitsBoot?.stop();
    if (options.closeDesignSystem && this.agentDashboardDesignSystem) {
      await this.agentDashboardDesignSystem.close();
      this.agentDashboardDesignSystem = null;
      this.registerDisabledAgentDashboardDbIpcHandlers();
    }
  }

  private registerDisabledAgentDashboardDbIpcHandlers(): void {
    if (this.disabledAgentDashboardDbIpcRegistered) {
      return;
    }

    this.disabledAgentDashboardDbIpcRegistered = true;
    // removeHandler-first (inside the helper) so this is safe even if live DB
    // IPC handlers are still registered — e.g. when shutting down or recovering
    // after a partially started Agent Monitor runtime.
    installDisabledAgentDashboardDbIpcHandlers(ipcMain);
  }

  private unregisterDisabledAgentDashboardDbIpcHandlers(): void {
    if (!this.disabledAgentDashboardDbIpcRegistered) {
      return;
    }

    for (const channel of [
      ...DESIGN_SYSTEM_DB_IPC_CHANNELS,
      ...SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST,
      ...SHARED_BRANCHES_IPC_CHANNEL_LIST,
    ]) {
      ipcMain.removeHandler(channel);
    }
    this.disabledAgentDashboardDbIpcRegistered = false;
  }

  openClaudeDashboard(): void {
    this.desktopWindow.showRoute("sessions");
  }

  private async handleGitHubResyncNudgeCommand(
    command: DesktopCommandEvent
  ): Promise<void> {
    await handleReservedGitHubResyncNudge(command, {
      getOnlineComputeTargetId: () => this.onlineComputeTargetId(),
      cloudSocket: this.cloudSocket,
      getAgentDashboard: () => this.agentDashboardDesignSystem,
      sendResyncRefreshToRenderer: (payload) =>
        this.desktopWindow.sendToRenderer(
          DesktopRendererEventChannel.GithubResyncNudge,
          payload
        ),
      log: (level, message) => gatewayLog[level]("github-resync", message),
    });
  }

  private handleSecurityUpgradeCommand(
    payload: DesktopSecurityUpgradePayload
  ): Promise<DesktopSecurityUpgradeResult> {
    return runSecurityUpgradeCommand(
      {
        getActiveGatewayId: () => this.getActiveGatewayId(),
        getOnlineComputeTargetId: () => this.onlineComputeTargetId(),
        getSandboxBaseDirectory: () =>
          this.settingsStore.getSandboxBaseDirectory(),
        apiKeyStore: this.apiKeyStore,
        runSecurityUpgradeProvisioning: (input) =>
          this.managedOnboarding.runSecurityUpgradeProvisioning(input),
      },
      payload
    );
  }

  private setPackagedUpdateState(patch: Partial<PackagedUpdateState>): void {
    this.packagedUpdateState = mergePackagedUpdateState(
      this.packagedUpdateState,
      patch
    );
  }

  private getPackagedUpdateStatusPayload(): PackagedUpdateStatusPayload {
    return toPackagedUpdateStatusPayload(this.packagedUpdateState);
  }

  private notifyPackagedUpdateStatus(): void {
    this.desktopWindow.sendToRenderer(
      DesktopRendererEventChannel.UpdateStatus,
      this.getPackagedUpdateStatusPayload()
    );
  }

  setQuitting(): void {
    this.desktopWindow.setQuitting();
  }

  /**
   * True once a downloaded packaged update is being applied. The before-quit
   * handler reads this to hand the relaunch to the updater instead of
   * force-exiting (FEA-2026).
   */
  isApplyingUpdate(): boolean {
    return this.applyingDownloadedUpdate;
  }

  /**
   * Hand control to electron-updater so it installs the downloaded update and
   * relaunches into the new version. Called by the before-quit continuation
   * only after graceful shutdown cleanup has completed.
   */
  finishUpdateInstall(): void {
    finishPackagedUpdateInstall({
      isFakeFeedActive: () => isFakeUpdateFeedActive(app.isPackaged),
      quit: () => app.quit(),
      log: (message) => gatewayLog.info("auto-update", message),
    });
  }

  /**
   * FEA-2349: every checkForUpdates() call site must route the result through
   * this guard so a download/staging failure can never become a fatal
   * unhandled rejection. The "error" event remains the state/telemetry
   * channel; see guardUpdateDownloadPromise for the full story.
   */
  private guardUpdateDownload(
    result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
  ): void {
    guardUpdateDownloadPromise(result, (message) =>
      gatewayLog.debug("auto-update", message)
    );
  }

  reportShutdownFailure(
    input: Omit<DesktopShutdownDiagnostics, "duringUpdate">
  ): void {
    reportDesktopShutdownFailure(input, this.applyingDownloadedUpdate);
  }

  async shutdown(): Promise<ShutdownResult> {
    if (this.shuttingDown) {
      return "clean";
    }
    this.shuttingDown = true;
    return await runDesktopApplicationShutdown({
      getAgentDashboardRuntime: () => this.agentDashboardDesignSystem,
      releaseSignIn: () => this.desktopSessionManager.releaseSignIn(),
      queueStatsTelemetryDebounce: this.queueStatsTelemetryDebounce,
      disposeAuthSessionLaneRecovery: () => {
        this.authSessionLaneRecovery = null;
      },
      stopAgentCapture: () => this.stopAgentCapture(),
      costReconciliation: this.costReconciliation,
      transcriptSync: this.transcriptSync,
      appLifecycleTelemetry: this.appLifecycleTelemetry,
      appOtelRuntime: this.appOtelRuntime,
      updateTelemetry: this.updateTelemetry,
      getUpdateRestartTargetVersion: () =>
        resolveUpdateRestartTargetVersion({
          applyingUpdate: this.applyingDownloadedUpdate,
          autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
          currentVersion: app.getVersion(),
          state: this.packagedUpdateState,
        }),
      unregisterDisabledAgentDashboardDbIpcHandlers: () =>
        this.unregisterDisabledAgentDashboardDbIpcHandlers(),
      getUpdateCheckTimer: () => this.updateCheckTimer,
      clearUpdateCheckTimer: () => {
        // `clearInterval` no-ops on a non-handle; the guard only guarded the reset.
        clearInterval(this.updateCheckTimer ?? undefined);
        this.updateCheckTimer = null;
      },
      cloudSocket: this.cloudSocket,
      realtimeHost: this.realtimeHost,
      commandExecutor: this.commandExecutor,
      server: this.server,
      desktopWindow: this.desktopWindow,
      tray: this.tray,
      isApplyingUpdate: () => this.applyingDownloadedUpdate,
      log: (message) => gatewayLog.info("shutdown", message),
      logWarning: (tag, message) => gatewayLog.warn(tag, message),
    }).finally(() => this.observabilityLaneRouter.dispose());
  }

  private async probeGatewayAlive(): Promise<boolean> {
    if (!this.server.isAlive()) {
      return false;
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.server.getActivePort()}/health`,
        { signal: AbortSignal.timeout(2000) }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /** The one "cloud egress is off" transition; both callers must leave this state. */
  private applyCloudConnectionDisabledState(): void {
    // ISS-4715: a chosen disabled setting must not report a connection fault.
    this.cloudStatus = CLOUD_DISABLED_BY_USER_STATUS;
    refreshDesktopSyncWriteLanes(this.syncLanes);
    this.refreshTrayState();
  }

  private onCloudSocketStatus(status: CloudSocketStatus): void {
    if (!this.cloudConnectionEnabled) {
      this.applyCloudConnectionDisabledState();
      return;
    }

    this.cloudStatus = status;
    refreshDesktopSyncWriteLanes(this.syncLanes);
    const stats = this.commandExecutor.getStats();

    if (status.state === "online") {
      // ISS-8691/8702/9081/9003: bind this id to the account and its minting
      // origin, and persist the PAIR the bind returns — never an id without it.
      this.credentialStore.persistManagedMetadata(
        this.sessionSyncIdentity.remember(status)
      );
      this.cloudSocket.sendPresence({
        state: this.cloudCommandsPaused ? "degraded" : "online",
        ...(this.cloudCommandsPaused
          ? { error: "cloud commands paused by user" }
          : {}),
        activeCommands: stats.activeCommands,
        queueDepth: stats.queueDepth,
      });
      this.refreshTrayState(
        `Serving on localhost:${this.server.getActivePort()} | cloud: online (${status.targetId})`
      );
      void this.recovery.onCloudOnline();
      // FEA-2923: reconcile newly assigned distributions on reconnect.
      this.requiredPluginInstaller.reconcileInBackground(status.targetId);
      // ISS-7710: the lane router reads cloudStatus, so report online only
      // after assignment and connection wiring complete.
      this.connectionLifecycle.reportOnline(status.targetId);
      this.observabilityLaneRouter.refreshAnalyticsReadiness();
      return;
    }

    this.commandExecutor.setConnected(false);

    if (status.state === "degraded") {
      this.connectionLifecycle.reportDegraded(status.error);
      this.cloudSocket.sendPresence({
        state: "degraded",
        error: status.error,
        ...this.commandExecutor.getStats(),
      });
      this.refreshTrayState(
        `Serving on localhost:${this.server.getActivePort()} | cloud degraded: ${status.error}`
      );
      return;
    }

    this.refreshTrayState();
  }

  private setCloudCommandsPaused(paused: boolean): void {
    this.cloudCommandsPaused = paused;
    this.settingsStore.setCloudCommandsPaused(paused);
    this.tray.setPaused(paused);
    this.refreshTrayState(paused ? "Gateway paused from tray/menu" : undefined);

    const stats = this.commandExecutor.getStats();
    this.cloudSocket.sendPresence(
      buildPausedAwarePresence({
        cloudOnline: this.cloudStatus.state === "online",
        paused,
        gatewayHealthy: this.recovery.gatewayHealthy,
        activeCommands: stats.activeCommands,
        queueDepth: stats.queueDepth,
      })
    );
  }

  private setCloudConnectionEnabled(enabled: boolean): void {
    setCloudConnectionEnabled(enabled, {
      isGoldenMode: () => this.goldenMode !== null,
      isEnabled: () => this.cloudConnectionEnabled,
      invalidateStartup: () => this.cloudSocketStartup.invalidate(),
      recordEnabled: (next) => {
        this.cloudConnectionEnabled = next;
        this.settingsStore.setCloudConnectionEnabled(next);
      },
      stop: () => this.cloudSocket.stop(),
      forgetIdentity: () => this.sessionSyncIdentity.forget(),
      applyDisabledState: () => this.applyCloudConnectionDisabledState(),
      applyIdleState: () => {
        this.cloudStatus = { state: "idle" };
        refreshDesktopSyncWriteLanes(this.syncLanes);
        this.refreshTrayState();
      },
      restart: () => this.cloudSocket.restart(),
    });
  }

  private applyDataSyncLevel(level: DataSyncLevel): void {
    applyDataSyncLevel(level, {
      hasTranscriptSyncLane: () => this.transcriptSync !== null,
      isGoldenMode: () => this.goldenMode !== null,
      isShuttingDown: () => this.shuttingDown,
      onLevelRecorded: () => this.sessionAnalysisConsent.reconcile(),
      setCloudCommandsPaused: (paused) => this.setCloudCommandsPaused(paused),
      setCloudConnectionEnabled: (enabled) =>
        this.setCloudConnectionEnabled(enabled),
      setDataSyncLevel: (next) => this.settingsStore.setDataSyncLevel(next),
      setPersistedCloudConnectionEnabled: (enabled) =>
        this.settingsStore.setCloudConnectionEnabled(enabled),
      startTranscriptSyncLane: () => {
        this.transcriptSync = this.createTranscriptSyncService();
        this.transcriptSync.start();
      },
    });
  }

  private restartCloudSocket(): void {
    if (this.goldenMode) {
      return;
    }
    this.cloudSocketStartup.invalidate();
    if (this.shuttingDown) {
      return;
    }
    if (!this.cloudConnectionEnabled) {
      return;
    }
    refreshDesktopSyncWriteLanes(this.syncLanes);
    this.cloudSocket.restart();
  }

  private syncPendingApprovalsToTray(): void {
    this.tray.setPendingApprovals(this.approvalStore.countPending());
  }

  private getSymphonyDir(): string {
    const sandboxBase = normalizeScopePath(
      this.settingsStore.getSandboxBaseDirectory()
    );
    if (!sandboxBase?.trim()) {
      throw new SymphonyDirNotConfiguredError();
    }
    return computeSymphonyDir(sandboxBase);
  }

  private isDebugAuthEnabled(): boolean {
    return process.env.CL_LOCAL_GATEWAY_DEBUG_AUTH === "1" && !app.isPackaged;
  }

  private isNoAuthMode(): boolean {
    return process.env.CL_LOCAL_GATEWAY_NO_AUTH === "1" && !app.isPackaged;
  }

  private isProdOriginsOnly(): boolean {
    return process.env.CL_LOCAL_GATEWAY_PROD_ORIGINS_ONLY === "1";
  }

  private getAllowedDirectoriesFromSandbox(): string[] {
    return buildAllowedDirectories(
      this.settingsStore.getSandboxBaseDirectory()
    );
  }

  /**
   * Fire a desktop Notification when a live agent session reaches a terminal
   * status, so users running a long session don't have to keep the window
   * focused to learn it finished. Gated on the `sessionCompletionNotifications`
   * flag; clicking deep-links to the session detail. Best-effort and never
   * throws into the DB-host message pump.
   */
  private notifySessionTerminal(notice: SessionTerminalNotice): void {
    if (!this.settingsStore.getFlag("sessionCompletionNotifications")) {
      return;
    }
    showSessionTerminalNotification(this.desktopWindow, notice);
  }

  private refreshTrayState(explicitDetails?: string): void {
    refreshDesktopTrayState(
      {
        tray: this.tray,
        gatewayHealthy: this.recovery.gatewayHealthy,
        getActivePort: () => this.server.getActivePort(),
        agentMonitorFailed: this.agentMonitorFailed,
        agentMonitorFailureReason: this.agentMonitorFailureReason,
        cloudCommandsPaused: this.cloudCommandsPaused,
        cloudStatus: this.cloudStatus,
      },
      explicitDetails
    );
  }

  private checkForUpdate(): Promise<DevUpdateCheckResult> {
    return checkForDevUpdate(this.repoRoot());
  }

  /** The monorepo root the dev-mode git update commands run against. */
  private repoRoot(): string {
    return path.resolve(__dirname, "../../../..");
  }

  /**
   * Dev-mode update nudge. Unlike packaged builds there is no download phase:
   * an available update (origin/main ahead of the built commit) is immediately
   * applicable via applyUpdate() (git pull --rebase + rebuild + relaunch). We
   * therefore emit the canonical "downloaded"/readyToInstall status so the
   * renderer UpdateBanner shows its Relaunch action right away rather than a
   * passive "available" message.
   */
  private async applyUpdate(): Promise<void> {
    await applyDevUpdate(this.repoRoot());
  }

  private registerIpcHandlers(): void {
    registerDesktopIpcHandlers({
      activityLog: this.activityLog,
      agentSessionSync: this.agentSessionSync,
      apiKeyStore: this.apiKeyStore,
      approvalEvaluator: this.approvalEvaluator,
      approvalStore: this.approvalStore,
      appOtelRuntime: this.appOtelRuntime,
      claudeCodeAnalytics: this.claudeCodeAnalytics,
      cloudSocket: this.cloudSocket,
      cloudSocketStartup: this.cloudSocketStartup,
      costReconciliation: this.costReconciliation,
      desktopSessionManager: this.desktopSessionManager,
      signOutDesktop: () =>
        coordinateDesktopSignOut(
          this.desktopSessionManager,
          this.managedOnboarding,
          this.signOutLoopCleanup
        ),
      desktopWindow: this.desktopWindow,
      docsHelp: this.docsHelp,
      gatewaySigningKeyStore: this.gatewaySigningKeyStore,
      getLegacyGatewayId: () => this.gatewayIdentity.currentSync(),
      managedOnboarding: this.managedOnboarding,
      recovery: this.recovery,
      realtimeHost: this.realtimeHost,
      rendererGates: this.rendererGates,
      requiredPluginInstaller: this.requiredPluginInstaller,
      server: this.server,
      sessionStore: this.sessionStore,
      settingsStore: this.settingsStore,
      syncBurndownReporter: this.syncBurndownReporter,
      telemetryOrgProvider: this.telemetryOrgProvider,
      applyBinaryPathPatch: (patch) =>
        this.applyBinaryPathPatchAndInvalidateCaches(patch),
      applyDataSyncLevel: (level) => this.applyDataSyncLevel(level),
      applyUpdate: () => this.applyUpdate(),
      attemptMoveToApplications: () =>
        this.updateBlockedController.attemptMoveToApplications(),
      canMoveBlockedUpdateToApplications: () =>
        this.updateBlockedController.canMoveBlockedUpdateToApplications(),
      checkForUpdate: () => this.checkForUpdate(),
      coachingPacksDir: () => this.coachingPacks.packsDir(),
      getActiveCoachingPackSeeded: () =>
        this.coachingPacks.getActivePackSeeded(),
      getAgentDashboardRuntime: () => this.agentDashboardDesignSystem,
      getAgentMonitorRuntimeStatus: () => this.agentMonitorRuntimeStatus,
      getAgentMonitorUrl: () => this.getAgentMonitorUrl(),
      getCloudCommandsPaused: () => this.cloudCommandsPaused,
      getCloudConnectionEnabled: () => this.cloudConnectionEnabled,
      getCloudStatus: () => this.cloudStatus,
      getComputeTargetLinkBlock: () => this.computeTargetLinkBlock.read(),
      getConnectionSecurityStatus: () =>
        this.credentialStore.getConnectionSecurityStatus(),
      getDangerousAutoApprove: () => this.dangerousAutoApprove,
      getGatewayAuthToken: () => this.gatewayAuthToken,
      getLocalSessionSourceStatus: () => this.getLocalSessionSourceStatus(),
      getPackagedUpdateState: () => this.packagedUpdateState,
      getPackagedUpdateStatusPayload: () =>
        this.getPackagedUpdateStatusPayload(),
      getCloudReadComputeTargetId: this.getCloudReadComputeTargetId,
      getTranscriptComputeTargetId: () => this.onlineComputeTargetId(),
      getUpdaterComputeTargetId: () => this.updaterComputeTargetId(),
      getTranscriptSync: () => this.transcriptSync,
      guardUpdateDownload: (result) => this.guardUpdateDownload(result),
      updateTelemetry: this.updateTelemetry,
      isAgentCoachingTipsEnabled: () => this.coachingPacks.isTipsEnabled(),
      isAgentMonitorReady: () => this.isAgentMonitorReady(),
      isCoachingPacksEnabled: () => this.coachingPacks.isPacksEnabled(),
      isDebugAuthEnabled: () => this.isDebugAuthEnabled(),
      isGoldenMode: () => this.goldenMode !== null,
      isLocalSessionSourceReady: () => this.isLocalSessionSourceReady(),
      isPlanExtractionEnabled: () =>
        this.settingsStore.getPlanExtractionEnabled(),
      isShuttingDown: () => this.shuttingDown,
      notifyInitialRendererLiveDbIdle: () =>
        this.rendererGates.notifyInitialRendererLiveDbIdle(),
      notifyPackagedUpdateStatus: () => this.notifyPackagedUpdateStatus(),
      notifyRendererUserInput: () =>
        this.rendererGates.notifyRendererUserInput(),
      onSessionAnalysisAgreed: () => this.sessionAnalysisConsent.reconcile(),
      openClaudeDashboard: () => this.openClaudeDashboard(),
      persistActiveProfileKey: (apiKey, provenance) =>
        this.credentialStore.persistActiveProfileKey(apiKey, provenance),
      refreshTrayState: (explicitDetails) =>
        this.refreshTrayState(explicitDetails),
      restartCloudSocket: () => this.restartCloudSocket(),
      restartCollectors: () =>
        this.sessionAnalysisConsent.restartCollectorsIfAgreed(() =>
          this.agentDashboardDesignSystem?.restartCollectors()
        ),
      setApplyingDownloadedUpdate: (value) => {
        this.applyingDownloadedUpdate = value;
      },
      setCloudCommandsPaused: (paused) => this.setCloudCommandsPaused(paused),
      setCloudConnectionEnabled: (enabled) =>
        this.setCloudConnectionEnabled(enabled),
      setDangerousAutoApprove: (enabled) => {
        this.dangerousAutoApprove = enabled;
      },
      setPackagedUpdateState: (patch) => this.setPackagedUpdateState(patch),
      transcriptStateDir: resolveDesktopTranscriptStateDir,
      yieldToMainLoop: () => yieldToMainLoop(),
    });
  }

  private signDesktopRequest(
    request: DesktopPopSigningRequest
  ): DesktopPopHeaders | null {
    return signDesktopRequestWithStoredKey({
      request,
      gatewayId: this.getActiveGatewayId(),
      loadKeyPair: (gatewayId) => this.gatewaySigningKeyStore.load(gatewayId),
    });
  }

  private reportBootstrapClaimDiagnostic(
    diagnostic: BootstrapClaimDiagnostic
  ): void {
    gatewayLog.warn(
      "desktop-pop",
      `PoP unavailable for ${diagnostic.surface}; routing to manual USER_CREATED setup (${diagnostic.reason})`
    );
    Observability.desktopPopUnavailable(diagnostic.surface, diagnostic.reason);
  }

  private reportDesktopPopUnavailable(surface: string, reason: string): void {
    Observability.desktopPopUnavailable(surface, reason);
  }

  private applyBinaryPathPatchAndInvalidateCaches(
    patch: BinaryPathPatch
  ): Partial<Record<CliBinaryTool, string>> {
    return applyBinaryPathOverride(this.settingsStore, patch);
  }

  private currentAccountAdmission() {
    return this.settingsStore.getSignOutCleanupState().isPending()
      ? null
      : this.desktopSessionManager.getAccountAdmission();
  }
}

const MAX_IN_FLIGHT_COMMANDS = 2;
const QUEUE_STATS_DEBOUNCE_MS = 1000;
