import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DistributionDto } from "@repo/api/src/types/distribution";
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
  STARTING_AGENT_MONITOR_RUNTIME_STATUS,
} from "../shared/agent-monitor-status.js";
import {
  buildCommandSigningCapabilities,
  shouldEnforceCommandSigning,
} from "../shared/command-signing-policy.js";
import {
  ConnectionSecurityMode,
  type ConnectionSecurityStatus,
} from "../shared/connection-security.js";
import {
  type DataSyncLevel,
  DesktopAuthStatus,
  EMPTY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
  type SavedConfig,
} from "../shared/contracts.js";
import { dataSyncLevelToBooleans } from "../shared/data-sync-level.js";
import {
  DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY,
  DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY,
  DESKTOP_ROUTINES_FEATURE_FLAG_KEY,
  DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY,
} from "../shared/feature-flags.js";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../shared/local-session-source-status.js";
import {
  buildAllowedDirectories,
  normalizeScopePath,
} from "../shared/sandbox-policy.js";
import { SCHEDULED_TASKS_IPC_CHANNEL_LIST } from "../shared/scheduled-tasks-channel.js";
import { SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST } from "../shared/shared-agent-sessions-contract.js";
import { SHARED_BRANCHES_IPC_CHANNEL_LIST } from "../shared/shared-branches-contract.js";
import {
  coachingPackSlug,
  getActiveCoachingPack,
  installCoachingPackFromDistribution,
  resolveBundledCoachingPacksDir,
  seedBundledCoachingPacks,
  shouldHonorDistributionDefault,
} from "./agent-monitor/agent-coaching-packs.js";
import { syncAgentMonitorHooksOnBoot } from "./agent-monitor/agent-monitor-hooks.js";
import type { AgentComponentInvocationSyncService } from "./agent-sync/agent-component-invocation-sync-service.js";
import { SessionSyncCapability } from "./agent-sync/agent-session-sync-capabilities.js";
import type { AgentSessionSyncService } from "./agent-sync/agent-session-sync-service.js";
import { isHttpAgentSessionSyncReady } from "./agent-sync/agent-session-sync-transport.js";
import { createDesktopSyncLanes } from "./agent-sync/desktop-sync-lane-composition.js";
import type { OrgSyncPolicyStore } from "./agent-sync/org-sync-policy-store.js";
import {
  type OrgSyncPolicySubscription,
  wireOrgSyncPolicySubscription,
} from "./agent-sync/org-sync-policy-subscription.js";
import { createSyncEgressGateAdapter } from "./agent-sync/sync-egress-gate-adapter.js";
import { ApprovalEvaluator } from "./approvals/approval-evaluator.js";
import {
  resolveOperationId,
  SUPPORTED_OPERATION_IDS,
} from "./approvals/approval-operations.js";
import type { ApprovalStore } from "./approvals/approval-store.js";
import { AuditService } from "./audit/audit-service.js";
import {
  type DesktopPopHeaders,
  type DesktopPopSigningRequest,
  DesktopPopUnavailableError,
  signDesktopPopHeaders,
} from "./auth/desktop-pop.js";
import type { LocalSessionStore } from "./auth/local-session-store.js";
import { CloudCommandExecutor } from "./cloud/cloud-command-executor.js";
import type {
  CloudSocketStatus,
  DesktopCommandEvent,
} from "./cloud/cloud-protocol.js";
import { CloudSocketService } from "./cloud/cloud-socket.js";
import {
  CloudSocketStartupCoordinator,
  logCloudSocketStartupFailure,
} from "./cloud/cloud-socket-startup.js";
import { createObservabilityLaneRouter } from "./cloud/observability-lane-router.js";
import { handleSecurityUpgradeCommand as runSecurityUpgradeCommand } from "./cloud/security-upgrade-command.js";
import type { AuthorizedCommandKeyStore } from "./command-signing/authorized-command-key-store.js";
import {
  classifyBrowserCommandKeyApprovalRequestCommand,
  handleBrowserCommandKeyApprovalRequestCommand as handleReservedBrowserCommandKeyApprovalRequest,
} from "./command-signing/browser-command-key-approval-request.js";
import {
  classifyBrowserCommandKeyRevocationCommand,
  handleBrowserCommandKeyRevocationCommand as handleReservedBrowserCommandKeyRevocation,
} from "./command-signing/browser-command-key-revocation.js";
import type { BrowserCommandKeyAppLifecycle } from "./command-signing/command-key-app-lifecycle.js";
import type { CommandKeyReconciler } from "./command-signing/command-key-reconciler.js";
import type { ActiveCommandKeyTargetContext } from "./command-signing/command-key-target-context.js";
import type { CommandSignatureVerifier } from "./command-signing/command-signature-verifier.js";
import { CommandSigningController } from "./command-signing/command-signing-controller.js";
import type {
  GatewaySigningKeyResult,
  GatewaySigningKeyStore,
} from "./command-signing/gateway-signing-key-store.js";
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
import {
  classifyGitHubResyncNudgeCommand,
  handleGitHubResyncNudgeCommand as handleReservedGitHubResyncNudge,
} from "./github/github-resync-nudge.js";
import type { BinaryPathPatch, CliBinaryTool } from "./ipc/binary-paths-ipc.js";
import { DESKTOP_AUTH_STATE_CHANGED_CHANNEL } from "./ipc/desktop-auth-ipc.js";
import { registerDesktopIpcHandlers } from "./ipc/desktop-ipc-registration.js";
import type { JobStore, LocalJob } from "./jobs/job-store.js";
import { reconcileJobStoreOnBoot } from "./jobs/job-store-boot-reconciliation.js";
import { scheduleAfterBootAdmission } from "./lifecycle/boot-admission-deadline.js";
import {
  reportDesktopShutdownFailure,
  runDesktopApplicationShutdown,
} from "./lifecycle/desktop-application-shutdown.js";
import { GatewayRecoveryManager } from "./lifecycle/gateway-recovery.js";
import { WindowShowIntent } from "./lifecycle/initial-window-reveal-gate.js";
import { RendererReadinessGates } from "./lifecycle/renderer-readiness-gates.js";
import type { ShutdownResult } from "./lifecycle/shutdown.js";
import { gatewayLog } from "./logging/gateway-logger.js";
import {
  describeDesktopBootIdentity,
  readPreviousSessionLogTail,
} from "./logging/persistent-log.js";
import type { BootstrapClaimDiagnostic } from "./onboarding/bootstrap-claim.js";
import { ManagedOnboardingController } from "./onboarding/managed-onboarding-controller.js";
import { installCoachingDistribution } from "./packs/coaching-distribution-install.js";
import {
  type CoachingInstallOutcome,
  RequiredPluginInstaller,
} from "./packs/required-plugin-installer.js";
import { buildRequiredPluginInstallerOptions } from "./packs/required-plugin-installer-options.js";
import { resolveResourcesDir } from "./resources-dir.js";
import type {
  DesktopAuthState,
  DesktopDeviceDescriptor,
  DesktopSessionManager,
} from "./session/desktop-session-manager.js";
import type { DesktopSessionStore } from "./session/desktop-session-store.js";
import {
  type SessionTerminalNotice,
  notifySessionTerminal as showSessionTerminalNotification,
} from "./session/session-terminal-notification.js";
import { SessionLimitsBoot } from "./session-limits/session-limits-boot.js";
import type { ApiKeyStore } from "./settings/api-key-store.js";
import { applyBinaryPathPatchAndInvalidateCaches as applyBinaryPathOverride } from "./settings/binary-path-override.js";
import type { GoldenModeConfig } from "./settings/golden-mode.js";
import type { SavedConfigManagedPatch } from "./settings/saved-config.js";
import { seedReposConfig } from "./settings/seed-repos-config.js";
import type { SettingsStore } from "./settings/settings-store.js";
import type { DesktopOtelRuntime } from "./telemetry/app-otel-runtime.js";
import {
  type DesktopAppLifecycleTelemetry,
  type DesktopAppOperatingMode,
  startDesktopOtelRuntimeForBoot,
} from "./telemetry/app-otel-runtime-lifecycle.js";
import { getDesktopAppOperatingModeForTelemetry } from "./telemetry/app-telemetry-operating-mode.js";
import { Observability } from "./telemetry/observability.js";
import type { TelemetryOrgProvider } from "./telemetry/telemetry-org-identity.js";
import type { DesktopShutdownDiagnostics } from "./telemetry/telemetry-protocol.js";
import { TraceCommentIdentityResolver } from "./trace-comments/trace-comment-identity-resolver.js";
import { createDesktopTranscriptSyncService } from "./transcript-sync/desktop-transcript-sync-factory.js";
import { kickTranscriptSweepAfterTierChange } from "./transcript-sync/transcript-sweep-kick.js";
import type { TranscriptSyncService } from "./transcript-sync/transcript-sync-service.js";
import { setMaterializedOpencodeTranscriptRoot } from "./transcript-sync/trusted-transcript-path.js";
import type { DesktopTray } from "./tray.js";
import { refreshDesktopTrayState } from "./tray-state.js";
import {
  createInitialPackagedUpdateState,
  mergePackagedUpdateState,
  type PackagedUpdateState,
  type PackagedUpdateStatusPayload,
  toPackagedUpdateStatusPayload,
} from "./update/packaged-update-state.js";
import type { RetrySpawnDeps } from "./util/spawn-retry.js";
import type { DesktopWindow } from "./window.js";

const { autoUpdater } = pkg;

import { GatewayIdentityStore } from "./auth/gateway-identity.js";
import { resolveManagedPopSigningReadiness } from "./auth/managed-pop-signing-readiness.js";
import type { PendingCommandKeyNotifier } from "./command-signing/pending-command-key-notifier.js";
import { BootRecoveryService } from "./lifecycle/boot-recovery.js";
import {
  type ManagedPopSigningReadiness,
  prepareLoopCommandForExecution,
} from "./loop/loop-command-preparer.js";
import type {
  LoopCompletedNotice,
  LoopCompletedNotifier,
} from "./loop/loop-completed-notifier.js";
import { LoopSchedulerContext } from "./loop/loop-scheduler-context.js";
import * as loopSleepRecovery from "./loop/loop-sleep-recovery.js";
import type { LoopTokenStore } from "./loop/loop-token-store.js";
import { isDesktopSetupCompleteFromState } from "./onboarding/setup-readiness.js";
import type { SyncBurndownReporter } from "./sync/sync-burndown-reporter.js";
import { startDesktopUpdateChecks } from "./update/auto-update-wiring.js";
import {
  applyDevUpdate,
  checkForDevUpdate,
  DEV_UPDATE_READY_STATUS,
  type DevUpdateCheckResult,
} from "./update/dev-update-commands.js";
import {
  FAKE_UPDATE_HANDOFF_MARKER,
  isFakeUpdateFeedActive,
} from "./update/fake-update-feed.js";
import {
  canApplyPackagedUpdate,
  resolvePackagedUpdateCheckResult,
} from "./update/update-and-restart-helpers.js";
import { UpdateBlockedController } from "./update/update-blocked-controller.js";
import { guardUpdateDownloadPromise } from "./update/update-install-blocked.js";
import { yieldToMainLoop } from "./util/main-loop-scheduling.js";
import type { NodeUuidStore } from "./util/node-uuid-store.js";
import {
  createQueueStatsDebounce,
  type QueueStatsDebounce,
} from "./util/queue-stats-debounce.js";
import { createUserIdentityChangeSubscription } from "./util/user-identity.js";

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
  private readonly authorizedCommandKeys: AuthorizedCommandKeyStore;
  private readonly commandSignatureVerifier: CommandSignatureVerifier;
  private readonly pendingCommandKeyNotifier: PendingCommandKeyNotifier;
  private readonly loopCompletedNotifier: LoopCompletedNotifier;
  private readonly commandKeyReconciler: CommandKeyReconciler;
  private readonly gatewaySigningKeyStore: GatewaySigningKeyStore;
  private readonly desktopSessionStore: DesktopSessionStore;
  private readonly desktopSessionManager: DesktopSessionManager;
  private readonly loopTokenStore: LoopTokenStore;
  private readonly nodeUuidStore: NodeUuidStore;
  private readonly appOtelRuntime: DesktopOtelRuntime;
  private readonly telemetryOrgProvider: TelemetryOrgProvider;
  private readonly traceCommentIdentityResolver =
    new TraceCommentIdentityResolver({
      getApiKey: () => this.apiKeyStore.getApiKey(),
      getApiOrigin: () => this.settingsStore.getApiOrigin(),
    });
  private readonly appLifecycleTelemetry: DesktopAppLifecycleTelemetry;
  private readonly tray: DesktopTray;
  private readonly desktopWindow: DesktopWindow;
  private readonly server: DesktopGatewayServer;
  private readonly cloudSocket: CloudSocketService;
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
  /** ISS-5387: read-only periodic burn-down over every desktop→cloud sync lane. */
  private readonly syncBurndownReporter: SyncBurndownReporter;
  // Session-limit snapshot producers (statusline capture + the owned `/usage`
  // endpoint). Started as one unit; no-op in golden mode.
  private sessionLimitsBoot: SessionLimitsBoot | null = null;
  // FEA-2923 (T-16.8/10): auto-install distributions on cloud online transition.
  private readonly requiredPluginInstaller: RequiredPluginInstaller;
  // FEA-2715: raw-transcript archive lane. Null unless the desktop feature flag
  // is on (constructed lazily in the ctor). Entirely separate from the metadata
  // lane above; a transcript failure never touches agentSessionSync. Not
  // `readonly`: `applyDataSyncLevel` can lazily (re)create it when a live level
  // change first turns the transcript lane on this session (FEA-3907).
  private transcriptSync: TranscriptSyncService | null;
  // FEA-4169 / ISS-4623 / ISS-4705: cached server-owned ORG POLICY — the OUTER
  // sync gate above per-device consent, from GET /desktop/identity. "unknown"
  // (pre-fetch, or a capable server that dropped the field) fails CLOSED and
  // self-heals; "unsupported" (an old server, no marker) degrades to device
  // consent. See org-sync-policy-store.ts + orgPolicyAllowsSessionSync.
  private readonly orgSyncPolicyStore: OrgSyncPolicyStore;
  // ISS-4623: disposable subscription re-kicking the sync lanes on org-policy
  // transitions. Disposed before the lanes stop so a refresh resolving during
  // teardown cannot restart an upload (see org-sync-policy-subscription.ts).
  private orgSyncPolicySubscription: OrgSyncPolicySubscription | null = null;
  private readonly costReconciliation: CostReconciliationService;
  private readonly claudeCodeAnalytics: ClaudeCodeAnalyticsService;
  private readonly activityLog: ActivityLogStore;
  private readonly approvalStore: ApprovalStore;
  private readonly jobStore: JobStore;
  private readonly recovery: GatewayRecoveryManager;
  private readonly bootRecovery: BootRecoveryService;
  private readonly schedulers: LoopSchedulerContext;
  private readonly gatewayAuthToken: string;
  private readonly legacyGatewayId: string;
  private readonly sessionStore: LocalSessionStore;
  private shuttingDown = false;
  private dangerousAutoApprove = false;
  private readonly approvalEvaluator: ApprovalEvaluator;
  private readonly commandSigningController: CommandSigningController;
  private readonly managedOnboarding: ManagedOnboardingController;
  private cloudStatus: CloudSocketStatus = { state: "idle" };
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
  private serverCommandSigningSupported = false;
  /** Live hello-ack capabilities; all reset false on disconnect for skew safety. */
  private serverAgentSessionSyncCapabilities = SessionSyncCapability.None;
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
    getAccessToken: () => this.desktopSessionManager.getAccessToken(),
    getApiOrigin: () => this.settingsStore.getApiOrigin(),
    getPluginVersion: () => this.cachedCodePluginVersion,
    onUnauthorized: () => this.desktopSessionManager.invalidateAccessToken(),
    isHttpReady: () => this.httpAgentSessionSyncReady(),
    getComputeTargetId: () => this.onlineComputeTargetId(),
  });
  private readonly commandKeyLifecycle: BrowserCommandKeyAppLifecycle;
  private updateCheckTimer: NodeJS.Timeout | null = null;
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
    this.authorizedCommandKeys = wired.authorizedCommandKeys;
    this.commandSignatureVerifier = wired.commandSignatureVerifier;
    this.commandKeyLifecycle = wired.commandKeyLifecycle;
    this.pendingCommandKeyNotifier = wired.pendingCommandKeyNotifier;
    this.loopCompletedNotifier = wired.loopCompletedNotifier;
    this.commandKeyReconciler = wired.commandKeyReconciler;
    this.loopTokenStore = wired.loopTokenStore;
    this.nodeUuidStore = wired.nodeUuidStore;
    this.appOtelRuntime = wired.appOtelRuntime;
    this.telemetryOrgProvider = wired.telemetryOrgProvider;
    this.appLifecycleTelemetry = wired.appLifecycleTelemetry;
    // Pure reads off the freshly-built settings store. Nothing wired above
    // writes either flag, so resolving them here is equivalent to the original
    // ordering (which read them immediately after constructing the store).
    this.cloudCommandsPaused = this.settingsStore.getCloudCommandsPaused();
    this.cloudConnectionEnabled =
      this.settingsStore.getCloudConnectionEnabled();
    this.gatewaySigningKeyStore = wired.gatewaySigningKeyStore;
    this.desktopSessionStore = wired.desktopSessionStore;
    this.desktopSessionManager = wired.desktopSessionManager;
    this.tray = wired.tray;
    this.desktopWindow = wired.desktopWindow;
    this.activityLog = wired.activityLog;
    this.jobStore = wired.jobStore;
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
    // PLN-1359 Phase 3: browser-command-signing key management (list/approve/
    // reject/notify) lives in its own collaborator. The dispatch handlers that
    // touch the cloud socket stay on the application for now.
    this.commandSigningController = new CommandSigningController({
      authorizedCommandKeys: this.authorizedCommandKeys,
      commandKeyLifecycle: this.commandKeyLifecycle,
      pendingCommandKeyNotifier: this.pendingCommandKeyNotifier,
      apiKeyStore: this.apiKeyStore,
      settingsStore: this.settingsStore,
      desktopWindow: this.desktopWindow,
      isServerCommandSigningSupported: () => this.serverCommandSigningSupported,
      signDesktopRequest: (request) => this.signDesktopRequest(request),
      reportDesktopPopUnavailable: (surface, reason) =>
        this.reportDesktopPopUnavailable(surface, reason),
    });
    // PLN-1359 Phase 3: managed/automated onboarding (open-file handoff queue,
    // trusted-config + managed-key provisioning, first-device browser
    // onboarding, run lifecycle, popup) lives in its own collaborator. It still
    // reaches app-owned methods (device descriptor, key persistence, cloud
    // restart) via callbacks; those move with the deferred cluster in Phase 4.
    this.managedOnboarding = new ManagedOnboardingController({
      settingsStore: this.settingsStore,
      apiKeyStore: this.apiKeyStore,
      desktopSessionManager: this.desktopSessionManager,
      gatewaySigningKeyStore: this.gatewaySigningKeyStore,
      telemetryOrgProvider: this.telemetryOrgProvider,
      desktopWindow: this.desktopWindow,
      isShuttingDown: () => this.shuttingDown,
      showWindow: () => this.showWindow(),
      getActiveGatewayId: () => this.getActiveGatewayId(),
      resolveDesktopDeviceDescriptor: () =>
        this.resolveDesktopDeviceDescriptor(),
      reportDesktopPopUnavailable: (surface, reason) =>
        this.reportDesktopPopUnavailable(surface, reason),
      signDesktopRequest: (request) => this.signDesktopRequest(request),
      persistActiveProfileKey: (apiKey, provenance) =>
        this.persistActiveProfileKey(apiKey, provenance),
      persistActiveConfigManagedMetadata: (patch) =>
        this.persistActiveConfigManagedMetadata(patch),
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
    const retrySpawnDeps: RetrySpawnDeps = {
      log: (level, msg) => gatewayLog[level]("spawn-retry", msg),
      refreshTray: (msg) => this.refreshTrayState(msg),
      isShuttingDown: () => this.shuttingDown,
      delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const gatewayIdentityStore = new GatewayIdentityStore(
      app.getPath("userData")
    );
    this.legacyGatewayId = gatewayIdentityStore.loadSync();
    // Initialized before the gateway server so the server constructor can take
    // ownership of the same instance the BootRecoveryService is later given.
    this.schedulers = new LoopSchedulerContext();
    this.server = DesktopGatewayServer.createDefault(
      this.settingsStore.getWebAppOrigin(),
      () => (this.isNoAuthMode() ? undefined : this.gatewayAuthToken),
      () => this.getAllowedDirectoriesFromSandbox(),
      os.hostname(),
      app.getVersion(),
      EMPTY_CAPABILITIES,
      (event) => {
        this.activityLog.add(event);
      },
      (request) => this.approvalEvaluator.evaluate(request),
      () => this.getSymphonyDir(),
      this.sessionStore,
      () => this.apiKeyStore.getApiKey(),
      () => this.settingsStore.getApiOrigin(),
      () => this.settingsStore.getWebAppOrigin(),
      this.isProdOriginsOnly(),
      this.jobStore,
      () => this.recovery.onUnexpectedClose(),
      this.loopTokenStore,
      retrySpawnDeps,
      () => this.getActiveGatewayId(),
      () => this.settingsStore.getBinaryPaths(),
      (patch) => this.applyBinaryPathPatchAndInvalidateCaches(patch),
      async () => {
        if (app.isPackaged) {
          const result = await autoUpdater.checkForUpdates();
          this.guardUpdateDownload(result);
          const remoteVersion = result?.updateInfo?.version;
          return resolvePackagedUpdateCheckResult(
            app.getVersion(),
            this.packagedUpdateState,
            remoteVersion
          );
        }
        return this.checkForUpdate();
      },
      async () => {
        if (app.isPackaged) {
          if (
            !canApplyPackagedUpdate(app.getVersion(), this.packagedUpdateState)
          ) {
            throw new Error("Update has not finished downloading yet");
          }
          // Same hand-off as the renderer IPC path (FEA-2026): mark the update
          // so the before-quit handler hands install + relaunch to the updater
          // via finishUpdateInstall() instead of force-exiting, then trigger a
          // graceful quit. Calling quitAndInstall() inline here without setting
          // applyingDownloadedUpdate reproduced the "Restarting…" hang on the
          // gateway-initiated update path.
          this.applyingDownloadedUpdate = true;
          Observability.electronUpdateInitiated({
            trigger: "gateway-apply-update",
            status: this.packagedUpdateState.status,
            version: this.packagedUpdateState.version,
            downloaded: true,
            readyToInstall: true,
          });
          app.quit();
          return;
        }
        await this.applyUpdate();
      },
      () => this.settingsStore.getUpdateAndRestartEnabled(),
      () => this.apiKeyStore.getApiKeyProvenance(),
      (request) => this.signDesktopRequest(request),
      (surface, reason) => this.reportDesktopPopUnavailable(surface, reason),
      () => this.onlineComputeTargetId(),
      (payload) => this.handleSecurityUpgradeCommand(payload),
      () => this.isDesktopSetupComplete(),
      this.schedulers,
      (notice) => this.handleLoopCompletedNotification(notice),
      createGatewayPackInstaller(() => this.agentDashboardDesignSystem),
      () => app.isPackaged
    );
    this.commandExecutor = new CloudCommandExecutor({
      getGatewayPort: () => this.server.getActivePort(),
      getGatewayAuthToken: () => this.gatewayAuthToken,
      maxInFlightCommands: MAX_IN_FLIGHT_COMMANDS,
      sendCommandAck: (event) => this.cloudSocket.sendCommandAck(event),
      sendCommandEvent: (event) => this.cloudSocket.sendCommandEvent(event),
      commandSignatureVerifier: this.commandSignatureVerifier,
      isCommandSigningEnforced: () => this.isCommandSigningEnforced(),
      prepareCommandForExecution: (command) =>
        this.prepareCloudCommandForExecution(command),
      onQueueStatsChange: (stats) => {
        const presenceState =
          this.cloudStatus.state === "online" &&
          !this.cloudCommandsPaused &&
          this.recovery.gatewayHealthy
            ? "online"
            : "degraded";
        this.cloudSocket.sendPresence({
          state: presenceState,
          ...(this.cloudCommandsPaused
            ? { error: "cloud commands paused by user" }
            : {}),
          activeCommands: stats.activeCommands,
          queueDepth: stats.queueDepth,
        });
        this.queueStatsTelemetryDebounce.trigger(stats);
      },
    });
    this.cloudSocket = new CloudSocketService({
      getRelayOrigin: () => this.settingsStore.getRelayOrigin(),
      getApiKey: () => this.apiKeyStore.getApiKey(),
      getApiKeyDiagnostic: () => this.apiKeyStore.getApiKeyDiagnostic(),
      getApiKeyProvenance: () => this.apiKeyStore.getApiKeyProvenance(),
      signDesktopRequest: (request) => this.signDesktopRequest(request),
      onDesktopPopUnavailable: (surface, reason) =>
        this.reportDesktopPopUnavailable(surface, reason),
      getAllowedDirectories: () => this.getAllowedDirectoriesFromSandbox(),
      getCapabilities: () =>
        this.getLocalCapabilities() as unknown as Record<string, unknown>,
      getMaxInFlightCommands: () => MAX_IN_FLIGHT_COMMANDS,
      getGatewayId: () => this.getUpgradeCapableGatewayId(),
      machineName: os.hostname(),
      pluginVersion: getCodePluginVersion(),
      desktopClientVersion: app.getVersion(),
      gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      getEnabledOperations: () => {
        const enabled = this.settingsStore.getUpdateAndRestartEnabled();
        return SUPPORTED_OPERATION_IDS.filter(
          (id) => id !== "update_and_restart" || enabled
        );
      },
      onStatusChange: (status) => this.onCloudSocketStatus(status),
      onDisconnect: (reason) => {
        this.serverCommandSigningSupported = false;
        this.serverAgentSessionSyncCapabilities = SessionSyncCapability.None;
        this.clearActiveCommandKeyTargetContext("disconnect");
        this.commandKeyReconciler.stop();
        this.agentSessionSync.refresh();
        this.agentComponentInvocationSync.refresh();
        this.commandSigningController.notifyCommandKeysChanged();
        Observability.connectionLost(reason);
      },
      onHelloAck: (event) => {
        this.serverCommandSigningSupported =
          event.serverCapabilities?.computeTargetSigning === true;
        this.serverAgentSessionSyncCapabilities =
          SessionSyncCapability.fromHelloAck(event.serverCapabilities);
        if (this.serverCommandSigningSupported) {
          this.setActiveCommandKeyTargetContext(event.computeTargetId);
        } else {
          this.clearActiveCommandKeyTargetContext("hello_ack_unsupported");
        }
        gatewayLog.info(
          "command-signing",
          `Server support from hello ack: computeTargetId=${event.computeTargetId}, computeTargetSigning=${event.serverCapabilities?.computeTargetSigning === true}`
        );
        if (this.serverCommandSigningSupported) {
          this.commandKeyReconciler.start();
          void this.commandKeyReconciler.reconcileNow("hello_ack");
        } else {
          this.commandKeyReconciler.stop();
        }
        this.commandSigningController.notifyCommandKeysChanged();
        Observability.setTargetId(event.computeTargetId);
        if (event.sessionId) {
          Observability.setGatewaySessionId(event.sessionId);
        }
        if (event.resumeFromSequence) {
          Observability.reconnectionResumed(
            "relay_resumed",
            Object.keys(event.resumeFromSequence).length
          );
          this.commandExecutor.replayFrom(event.resumeFromSequence);
        }
        Observability.connectionEstablished(
          event.computeTargetId,
          process.env.NODE_ENV ?? "production"
        );
        this.agentSessionSync.refresh();
        this.agentComponentInvocationSync.refresh();
      },
      onCommand: (command) => {
        const githubResyncNudgeMatch =
          classifyGitHubResyncNudgeCommand(command);
        if (githubResyncNudgeMatch === "match") {
          void this.handleGitHubResyncNudgeCommand(command);
          return;
        }
        if (githubResyncNudgeMatch === "mismatch") {
          this.cloudSocket.sendCommandAck({
            commandId: command.commandId,
            accepted: false,
            state: "failed",
            reason: "operationId/path mismatch",
          });
          return;
        }
        const keyApprovalRequestMatch =
          classifyBrowserCommandKeyApprovalRequestCommand(command);
        if (keyApprovalRequestMatch === "match") {
          this.handleBrowserCommandKeyApprovalRequestCommand(command);
          return;
        }
        if (keyApprovalRequestMatch === "mismatch") {
          this.cloudSocket.sendCommandAck({
            commandId: command.commandId,
            accepted: false,
            state: "failed",
            reason: "operationId/path mismatch",
          });
          return;
        }
        const keyRevocationMatch =
          classifyBrowserCommandKeyRevocationCommand(command);
        if (keyRevocationMatch === "match") {
          this.handleBrowserCommandKeyRevocationCommand(command);
          return;
        }
        if (keyRevocationMatch === "mismatch") {
          this.cloudSocket.sendCommandAck({
            commandId: command.commandId,
            accepted: false,
            state: "failed",
            reason: "operationId/path mismatch",
          });
          return;
        }
        if (!this.isDesktopSetupComplete()) {
          this.cloudSocket.sendCommandAck({
            commandId: command.commandId,
            accepted: false,
            state: "failed",
            reason: "onboarding not completed",
          });
          return;
        }
        const resolvedOperationId = resolveOperationId(command.path);
        // Accept the command if either:
        // 1. The operationId matches exactly (explicit dispatch like symphony_loop)
        // 2. The path resolves to a known operation (relay HTTP proxy uses random UUIDs)
        if (!resolvedOperationId) {
          this.cloudSocket.sendCommandAck({
            commandId: command.commandId,
            accepted: false,
            state: "failed",
            reason: "operationId/path mismatch",
          });
          return;
        }
        if (this.cloudCommandsPaused) {
          this.cloudSocket.sendCommandAck({
            commandId: command.commandId,
            accepted: false,
            state: "failed",
            reason: "cloud commands paused by user",
          });
          return;
        }
        this.commandExecutor.enqueue(command);
      },
      onCancel: (event) => {
        this.commandExecutor.cancel(event);
      },
      onCommandEventAck: (event) => {
        this.commandExecutor.acknowledge(event);
      },
    });
    // FEA-4169 / Gap B (#2570 follow-up) / FEA-3425 (PLN-1437 Phase 4a): the
    // cloud sync lanes and the org-policy gate cache they sit behind, composed
    // in one place. All three share the first-party session Bearer transport and
    // stay inert until their own gates open.
    const syncLanes = createDesktopSyncLanes({
      getAccessToken: () => this.desktopSessionManager.getAccessToken(),
      getApiKey: () => this.apiKeyStore.getApiKey(),
      getApiOrigin: () => this.settingsStore.getApiOrigin(),
      invalidateAccessToken: () =>
        this.desktopSessionManager.invalidateAccessToken(),
      getTranscriptComputeTargetId: () => this.transcriptComputeTargetId(),
      getOnlineComputeTargetId: () => this.onlineComputeTargetId(),
      isSessionMetadataSyncTierAllowed: () =>
        this.syncEgressGate.sessionMetadataAllowed(),
      isHttpAgentSessionSyncReady: () => this.httpAgentSessionSyncReady(),
      isSyncCompressionSupported: () =>
        this.serverAgentSessionSyncCapabilities.compression,
      isSyncActivityChunkingSupported: () =>
        this.serverAgentSessionSyncCapabilities.activityChunking,
      isSyncMonitoredActivitySupported: () =>
        this.serverAgentSessionSyncCapabilities.monitoredActivity,
      getSyncSource: () => this.agentDashboardDesignSystem?.syncSource ?? null,
      waitForBackgroundSlot: () =>
        this.rendererGates.waitForRendererBackgroundSlot(),
      appOtelRuntime: this.appOtelRuntime,
      isTranscriptSyncRunning: () => this.transcriptSync?.isRunning() ?? false,
      // ISS-5387: the trace-comment lane's gate, mirroring
      // `hasCloudTraceCommentsAuth` — a live first-party session AND an API
      // origin, plus a composed dashboard runtime to host the driver at all.
      // Without this the burn-down could not tell `idle_not_running` from
      // `drained` for the lane whose shut gate is the likeliest cause of a
      // backlog: signed out, every authored comment just sits on disk.
      isTraceCommentSyncRunning: () =>
        this.agentDashboardDesignSystem !== null &&
        this.desktopSessionManager.getState().status ===
          DesktopAuthStatus.Authenticated &&
        Boolean(this.settingsStore.getApiOrigin()),
    });
    this.orgSyncPolicyStore = syncLanes.orgSyncPolicyStore;
    this.agentSessionSync = syncLanes.agentSessionSync;
    this.agentComponentInvocationSync = syncLanes.agentComponentInvocationSync;
    this.syncBurndownReporter = syncLanes.syncBurndownReporter;
    this.wireOrgSyncPolicyAndAuthSubscriptions();
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
          this.installCoachingDistribution(dist),
        getWindow: () => this.desktopWindow,
        isDistributionDeclined: (distributionId, computeTargetId) =>
          this.settingsStore.isDistributionDeclined(
            distributionId,
            computeTargetId
          ),
        recordDeclinedDistribution: (record) =>
          this.settingsStore.recordDeclinedDistribution(record),
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
        this.transcriptStateDir(),
        "transcript-materialized",
        "opencode"
      )
    );
    // FEA-2715: raw-transcript archive lane, off unless the desktop feature flag
    // is on (restart-scoped). Constructed here so it is a hard no-op when off.
    this.transcriptSync = this.isTranscriptSyncEnabled()
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
    this.bootRecovery = new BootRecoveryService({
      jobStore: this.jobStore,
      telemetry: Observability.getTelemetryEmitter(),
      getApiKey: () => this.apiKeyStore.getApiKey(),
      getApiOrigin: () => this.settingsStore.getApiOrigin(),
      getAllowedDirectories: () => this.getAllowedDirectoriesFromSandbox(),
      loopTokenStore: this.loopTokenStore,
      schedulers: this.schedulers,
      // Wire PoP deps so boot-recovered loops attach X-Desktop-* headers and
      // use the managed-key fallback for revival (AC-005).
      getApiKeyProvenance: () => this.apiKeyStore.getApiKeyProvenance(),
      signDesktopRequest: (request) => this.signDesktopRequest(request),
      onDesktopPopUnavailable: (surface, reason) =>
        this.reportDesktopPopUnavailable(surface, reason),
    });
    this.registerIpcHandlers();
    this.managedOnboarding.registerOnboardingFileOpenHandler();
  }

  /**
   * The seam the composition root wires collaborators against (PLN-1359 Phase 2).
   *
   * Every member is invoked lazily — after construction completes — so it may
   * safely reach services and fields assigned further down the constructor
   * (`this.cloudSocket`, `this.desktopWindow`). That is exactly what the previous
   * inline `() => this.x` callbacks relied on; this only makes the coupling
   * explicit and typed instead of implicit.
   */
  private createServicesHost(): DesktopServicesHost {
    return {
      sendProductAnalytics: (event) =>
        this.observabilityLaneRouter.sendAnalytics(event),
      flushProductAnalytics: (options) =>
        this.observabilityLaneRouter.flushAnalytics(options),
      sendDesktopTelemetry: (event) =>
        this.observabilityLaneRouter.sendTelemetry(event),
      flushDesktopTelemetry: (options) =>
        this.observabilityLaneRouter.flushTelemetry(options),
      showDesktopWindow: () => this.desktopWindow.show(),
      getActiveGatewayId: () => this.getActiveGatewayId(),
      getNodeUuidForTelemetry: () => this.getNodeUuidForTelemetry(),
      getAppOperatingModeForTelemetry: () =>
        this.getAppOperatingModeForTelemetry(),
      getPendingCommandSigningKeysForNotification: () =>
        this.commandSigningController.getPendingCommandSigningKeysForNotification(),
      openBrowserCommandKeysSettings: () =>
        this.commandSigningController.openBrowserCommandKeysSettings(),
      approveOrganizationCommandPublicKey: (fingerprint) =>
        this.commandSigningController.approveOrganizationCommandPublicKey(
          fingerprint
        ),
      rejectOrganizationCommandPublicKey: (fingerprint) =>
        this.commandSigningController.rejectOrganizationCommandPublicKey(
          fingerprint
        ),
      notifyCommandKeysChanged: () =>
        this.commandSigningController.notifyCommandKeysChanged(),
      fetchOrganizationCommandKeyClassification: (reason) =>
        this.commandSigningController.fetchOrganizationCommandKeyClassification(
          reason
        ),
      notifyPendingCommandSigningKeysForOrganizationKeys: (organizationKeys) =>
        this.commandSigningController.notifyPendingCommandSigningKeysForOrganizationKeys(
          organizationKeys
        ),
      signDesktopRequest: (request) => this.signDesktopRequest(request),
      resolveDesktopDeviceDescriptor: () =>
        this.resolveDesktopDeviceDescriptor(),
      publishDesktopAuthState: (state) => this.publishDesktopAuthState(state),
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

  getAppOperatingModeForTelemetry(): DesktopAppOperatingMode {
    return getDesktopAppOperatingModeForTelemetry(this.apiKeyStore);
  }

  async boot(): Promise<void> {
    gatewayLog.setVerbose(this.settingsStore.getAll().verboseLogging);
    await startDesktopOtelRuntimeForBoot({
      runtime: this.appOtelRuntime,
      logWarning: (tag, message) => gatewayLog.warn(tag, message),
    });
    this.appLifecycleTelemetry.start();
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
      onOpen: () => this.desktopWindow.show(),
      onManageCommandKeys: () =>
        this.commandSigningController.openBrowserCommandKeysSettings(),
      onOpenClaudeDashboard: () => this.openClaudeDashboard(),
      onTogglePaused: (paused) => this.setCloudCommandsPaused(paused),
    });
    this.tray.setPaused(this.cloudCommandsPaused);
    this.syncPendingApprovalsToTray();
    // The migrated Desktop window always loads the DB-backed design-system
    // renderer, so IPC handlers must exist even when capture is disabled.
    this.registerDisabledAgentDashboardDbIpcHandlers();
    this.desktopWindow.init();
    // Restore the first-party desktop session (FEA-2219) off the keychain and
    // refresh once so a revoked/expired session is detected at startup. Fire
    // and forget — the manager pushes the resolved state to the renderer (which
    // also pulls the current state on mount), and a network failure keeps the
    // stored credentials for a later getAccessToken retry. Never blocks boot.
    void this.desktopSessionManager.restore().catch((error) => {
      gatewayLog.warn(
        "desktop-auth",
        `Session restore failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    this.managedOnboarding.markBootReadyForOnboarding();
    void this.managedOnboarding.drainQueuedOnboardingHandoffs();
    void this.managedOnboarding.processCanonicalOnboardingHandoff("cold-start");
    void this.managedOnboarding.maybeShowOnboardingPopup();

    void this.seedPreviousSessionLogTail();
    const deadJobs = this.reconcileJobStore();
    const bootSandbox = this.settingsStore.getSandboxBaseDirectory();
    this.schedulePostInitialWindowBootTasks(bootSandbox);
    // Unconditional and NOT inside the call above: the lanes must never wait on
    // the window being revealed. See startSyncLanesAtBoot.
    this.startSyncLanesAtBoot();

    // Register the sleep/wake recovery listener so active loops refresh their
    // tokens and send heartbeats after the system wakes from sleep.
    loopSleepRecovery.init();

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
      void this.bootRecovery
        .startDeadJobFinalization(deadJobs)
        .catch((err: unknown) => {
          gatewayLog.warn(
            "boot-recovery",
            `Background dead-loop finalization failed: ${err instanceof Error ? err.message : String(err)}`
          );
        });

      if (this.goldenMode) {
        this.cloudStatus = {
          state: "degraded",
          error: "Golden mode: cloud sync disabled",
        };
      } else if (this.cloudConnectionEnabled) {
        this.scheduleCloudSocketStartAfterInitialUi();
      } else {
        this.cloudStatus = {
          state: "degraded",
          error: "Cloud connection disabled by user",
        };
      }

      startDesktopUpdateChecks({
        getPackagedUpdateState: () => this.packagedUpdateState,
        setPackagedUpdateState: (patch) => this.setPackagedUpdateState(patch),
        notifyPackagedUpdateStatus: () => this.notifyPackagedUpdateStatus(),
        handleUpdateInstallBlocked: (version) =>
          this.handleUpdateInstallBlocked(version),
        guardUpdateDownload: (result) => this.guardUpdateDownload(result),
        sendUpdateAvailableToRenderer: (payload) =>
          this.desktopWindow.sendToRenderer(
            "desktop:update-available",
            payload
          ),
        checkForUpdate: () => this.checkForUpdate(),
        notifyRendererDevUpdateReady: () => this.notifyRendererDevUpdateReady(),
        getUpdateCheckTimer: () => this.updateCheckTimer,
        setUpdateCheckTimer: (timer) => {
          this.updateCheckTimer = timer;
        },
      });
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

      void this.bootRecovery.reattachLiveJobs().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        gatewayLog.warn(
          "boot-recovery",
          `Live loop reattach failed after boot: ${message}`
        );
      });
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
          this.settingsStore.getFlag(
            DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY
          ),
      });
      // Never rejects; the promise only reports that the lazily-loaded
      // statusline half has been attempted, which boot does not wait on.
      this.sessionLimitsBoot.start().catch(() => undefined);
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
   * NOT by ordering — `getSyncSource()` may return null, a null pass consumes no
   * budget, and the 5s tick retries. Connectivity is lazy too
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
    this.agentSessionSync.start(options);
    this.agentComponentInvocationSync.start();
    this.syncBurndownReporter.start();
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

  /**
   * Returns the gateway identity for the active saved profile, creating a
   * profile-scoped UUID when needed. Unsaved legacy installs keep the original
   * singleton identity for backward compatibility.
   */
  private getActiveGatewayId(): string {
    const activeConfigId = this.settingsStore.getActiveConfigId();
    if (!activeConfigId) {
      return this.legacyGatewayId;
    }
    return (
      this.settingsStore.ensureConfigGatewayId(activeConfigId).gatewayId ??
      this.legacyGatewayId
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

  private async prepareCloudCommandForExecution(
    command: DesktopCommandEvent
  ): Promise<DesktopCommandEvent> {
    return prepareLoopCommandForExecution(command, {
      getApiOrigin: () => this.settingsStore.getApiOrigin(),
      getApiKey: () => this.apiKeyStore.getApiKey(),
      getApiKeyProvenance: () => this.apiKeyStore.getApiKeyProvenance(),
      getManagedPopSigningReadiness: () => this.getManagedPopSigningReadiness(),
      getComputeTargetId: () => this.onlineComputeTargetId(),
      signDesktopRequest: (request) => this.signDesktopRequest(request),
      onDesktopPopUnavailable: (surface, reason) =>
        this.reportDesktopPopUnavailable(surface, reason),
    });
  }

  private getManagedPopSigningReadiness(): ManagedPopSigningReadiness {
    return resolveManagedPopSigningReadiness({
      mode: this.getConnectionSecurityStatus().mode,
      provenance: this.apiKeyStore.getApiKeyProvenance() ?? "USER_CREATED",
    });
  }

  private getUpgradeCapableGatewayId(): string | null {
    const keyPair = this.getOrCreateActiveSigningKey();
    return keyPair.ok ? keyPair.keyPair.gatewayId : null;
  }

  private getActiveConfig(): SavedConfig | null {
    return this.settingsStore.getActiveConfig();
  }

  private getConnectionSecurityStatus(): ConnectionSecurityStatus {
    const apiKeyStatus = this.apiKeyStore.getStatus();
    if (!apiKeyStatus.hasApiKey) {
      return {
        mode: ConnectionSecurityMode.Unconfigured,
        detail: "No cloud API key is configured.",
      };
    }
    if (apiKeyStatus.provenance !== "DESKTOP_MANAGED") {
      return {
        mode: ConnectionSecurityMode.Standard,
        detail: "Using a manually configured bearer key.",
      };
    }

    const keyPair = this.gatewaySigningKeyStore.load(this.getActiveGatewayId());
    if (!keyPair.ok) {
      return {
        mode: ConnectionSecurityMode.SigningUnavailable,
        detail: "Managed key is present but request signing is unavailable.",
      };
    }

    return {
      mode: ConnectionSecurityMode.Enhanced,
      detail: "Managed key with request signing is configured.",
    };
  }

  private getOrCreateActiveSigningKey(): GatewaySigningKeyResult {
    const gatewayId = this.getActiveGatewayId();
    const keyPair = this.gatewaySigningKeyStore.getOrCreate(gatewayId);
    if (keyPair.ok) {
      this.persistActiveConfigManagedMetadata({
        gatewayId,
        gatewayPublicKeyPem: keyPair.keyPair.publicKeySpkiPem,
        desktopSecurityUpgradeProtocolVersion: 1,
      });
    }
    return keyPair;
  }

  private persistActiveConfigManagedMetadata(
    patch: SavedConfigManagedPatch
  ): void {
    this.settingsStore.updateActiveConfigManagedMetadata(patch);
  }

  /**
   * Device descriptor for first-party desktop sign-in (FEA-2219). Reuses the
   * active gateway's Ed25519 key — the same keypair the PoP signer and the
   * inline managed-onboarding flow use — so the eventual session credentials
   * bind to the existing device identity. Throws when the signing key is
   * unavailable; {@link DesktopSessionManager} treats that as `start_failed`.
   */
  private resolveDesktopDeviceDescriptor(): DesktopDeviceDescriptor {
    const keyPair = this.getOrCreateActiveSigningKey();
    if (!keyPair.ok) {
      throw new Error(`Desktop signing key unavailable: ${keyPair.reason}`);
    }
    return {
      gatewayId: keyPair.keyPair.gatewayId,
      gatewayPublicKeyPem: keyPair.keyPair.publicKeySpkiPem,
      machineName: os.hostname(),
      platform: process.platform,
      desktopVersion: app.getVersion(),
    };
  }

  /** Pushes a desktop auth-state transition to the renderer AuthAdapter. */
  private publishDesktopAuthState(state: DesktopAuthState): void {
    this.desktopWindow.sendToRenderer(
      DESKTOP_AUTH_STATE_CHANGED_CHANNEL,
      state
    );
  }

  /**
   * Trace-comment REST sync can run while the relay socket is reconnecting.
   * Session comments still need the profile-scoped compute target so the API can
   * resolve local external session ids to the already-synced cloud artifact.
   */
  private getTraceCommentComputeTargetId(): string | null {
    if (this.cloudStatus.state === "online") {
      return this.cloudStatus.targetId;
    }
    return this.settingsStore.getActiveConfig()?.lastComputeTargetId ?? null;
  }

  /** Live compute target when cloud is online, else null (strict-online; no `lastComputeTargetId` fallback, unlike {@link getTraceCommentComputeTargetId}). */
  private onlineComputeTargetId(): string | null {
    return this.cloudStatus.state === "online"
      ? this.cloudStatus.targetId
      : null;
  }

  private persistActiveProfileKey(
    apiKey: string,
    provenance: "USER_CREATED" | "DESKTOP_MANAGED"
  ): void {
    const activeConfig = this.getActiveConfig();
    if (!activeConfig) {
      return;
    }
    this.apiKeyStore.saveProfileKey(activeConfig.id, apiKey, provenance);
    this.persistActiveConfigManagedMetadata({ apiKeySource: provenance });
  }

  /**
   * Live-exit hook from the loop finalizer: raise an OS notification that the
   * user's loop finished. Gated behind the opt-in Loop Completion Notifications
   * flag so the default experience is unchanged until the feature is enabled.
   */
  private handleLoopCompletedNotification(notice: LoopCompletedNotice): void {
    if (!this.settingsStore.getLoopCompletedNotificationsEnabled()) {
      return;
    }
    this.loopCompletedNotifier.notifyCompleted(notice);
  }

  private isTranscriptSyncEnabled(): boolean {
    return this.settingsStore.getTranscriptSyncEnabled();
  }

  /**
   * FEA-3425: live-state adapter over the tested transport predicate
   * ({@link isHttpAgentSessionSyncReady}), shared by Lane 1 and (Phase 3) the
   * observability lanes. Identity remains socket-derived in this phase
   * (PLN-1437 D6) — the credential and transport decouple from the relay,
   * identity resolution does not yet.
   */
  private httpAgentSessionSyncReady(): boolean {
    return isHttpAgentSessionSyncReady({
      authStatus: this.desktopSessionManager.getState().status,
      cloudOnline: this.cloudStatus.state === "online",
    });
  }

  /**
   * FEA-4169 / ISS-4623 / ISS-4705 / ISS-5348: the session-data egress gate,
   * bound to the live stores. The pure two-layer decision (server-owned ORG
   * POLICY ANDed above the per-device consent tier, so it can only suppress,
   * never widen; `"unknown"` fails CLOSED, `"unsupported"` degrades) lives in
   * `sync-egress-gate.ts`; the store binding lives in
   * `sync-egress-gate-adapter.ts`. Both halves are out of this grandfathered
   * file on purpose.
   */
  private readonly syncEgressGate = createSyncEgressGateAdapter({
    ensureResolved: () => void this.orgSyncPolicyStore.ensureResolved(),
    getConsentRecord: () => this.settingsStore.getSyncConsentRecord(),
    getPolicyState: () => this.orgSyncPolicyStore.getPolicyState(),
    getSessionOrganizationId: () =>
      this.desktopSessionManager.getState().organizationId,
  });

  /** The live relay compute target id, or null when the cloud link is offline. */
  private transcriptComputeTargetId(): string | null {
    return this.onlineComputeTargetId();
  }

  /**
   * ISS-4623: wire the org-policy → sync-lane re-kick subscription (disposable +
   * shutdown-gated) and the auth-session-change reaction. The reset/refresh
   * identity-diff, shutdown gating, and dispose lifecycle all live in
   * org-sync-policy-subscription.ts; this only binds them to the lanes. Extracted
   * from the constructor to keep the grandfathered app.ts shrinking.
   */
  private wireOrgSyncPolicyAndAuthSubscriptions(): void {
    this.orgSyncPolicySubscription = wireOrgSyncPolicySubscription({
      store: this.orgSyncPolicyStore,
      isShuttingDown: () => this.shuttingDown,
      getAccountIdentity: () => this.desktopSessionManager.getIdentity(),
      laneKicks: {
        refreshAgentSessionSync: () => this.agentSessionSync.refresh(),
        refreshComponentInvocationSync: () =>
          this.agentComponentInvocationSync.refresh(),
        kickTranscriptSweep: () =>
          kickTranscriptSweepAfterTierChange(this.transcriptSync),
      },
    });
    this.desktopSessionManager.subscribe(() => {
      this.orgSyncPolicySubscription?.onAuthSessionChange();
      this.agentSessionSync.refresh();
      this.observabilityLaneRouter.resetForSession();
    });
  }

  // FEA-2715: assemble the transcript archive-lane service. The control-plane
  // client authenticates with the first-party desktop session JWT (withAnyAuth
  // Bearer); the executor reads the relay compute-target id for the request
  // body. The fingerprint store is reached lazily through the agent-dashboard
  // runtime (null until the db host is ready), so the service self-no-ops until
  // both the DB and connectivity exist.
  /**
   * The collector/materializer state directory — the same
   * `<userData>/agent-dashboard-ingest` the dashboard runtime's CollectorManager
   * uses, so the OpenCode materializer's fingerprint + projection files live
   * alongside the ingest caches (FEA-3932).
   */
  private transcriptStateDir(): string {
    return path.join(app.getPath("userData"), "agent-dashboard-ingest");
  }

  private createTranscriptSyncService(): TranscriptSyncService {
    return createDesktopTranscriptSyncService({
      getAccessToken: () => this.desktopSessionManager.getAccessToken(),
      getApiOrigin: () => this.settingsStore.getApiOrigin(),
      stateDir: this.transcriptStateDir(),
      getAgentDashboardRuntime: () => this.agentDashboardDesignSystem,
      getComputeTargetId: () => this.transcriptComputeTargetId(),
      isTranscriptSyncEnabled: () => this.isTranscriptSyncEnabled(),
      isTranscriptSyncTierAllowed: () =>
        this.syncEgressGate.transcriptAllowed(),
      getTranscriptSyncTierGate: () => this.syncEgressGate.transcriptGate(),
      hasDesktopSessionAuth: () =>
        this.desktopSessionManager.getState().status ===
        DesktopAuthStatus.Authenticated,
    });
  }

  private isPlanExtractionEnabled(): boolean {
    return this.settingsStore.getPlanExtractionEnabled();
  }

  private isAgentCoachingTipsEnabled(): boolean {
    return this.settingsStore.getFlag(
      DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY
    );
  }

  // Coaching packs ride on top of coaching tips: the override only applies when
  // BOTH the tips feature and the packs flag are on. Off → built-in signals.
  private isCoachingPacksEnabled(): boolean {
    return (
      this.isAgentCoachingTipsEnabled() &&
      this.settingsStore.getFlag(DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY)
    );
  }

  // Seed-once guard: bundled coaching packs are copied into userData the first
  // time the active pack is read this process, then left alone (so a user's
  // later pack choice is never re-seeded over).
  private coachingPacksSeeded = false;

  private coachingPacksDir(): string {
    return path.join(app.getPath("userData"), "coaching-packs");
  }

  /**
   * FEA-3847 (PRD-556 M1): the bundled audit-bot character-prompt directory
   * (`<character>.md`). Shipped unpacked via `electron-builder.yml` extraResources
   * so it resolves from `resourcesPath` in a packaged build (mirrors the dock
   * icon / coaching-pack resource resolution).
   */
  private auditCharactersDir(): string {
    return path.join(resolveResourcesDir(), "audit-characters");
  }

  /**
   * The main-process audit runner (FEA-3847). Owns sandbox validation of the
   * target repo + the crewd cascade. Construction is cheap (no I/O — the
   * login-shell PATH is resolved lazily on the first `run()`), so it is built
   * once at IPC-handler registration and reused across runs.
   */
  private auditServiceInstance: AuditService | null = null;

  private getAuditService(): AuditService {
    if (!this.auditServiceInstance) {
      this.auditServiceInstance = new AuditService({
        promptsDir: this.auditCharactersDir(),
        getAllowedDirectories: () => this.getAllowedDirectoriesFromSandbox(),
        // FEA-3849 (M3): the ClosedLoop filing call is main-side — the desktop
        // access token (bearer) and api origin build the typed client here in
        // the trust zone; neither crosses to the renderer.
        getAccessToken: () => this.desktopSessionManager.getAccessToken(),
        getApiOrigin: () => this.settingsStore.getApiOrigin(),
        log: (message) => gatewayLog.info("audit", message),
      });
    }
    return this.auditServiceInstance;
  }

  private getActiveCoachingPackSeeded() {
    const packsDir = this.coachingPacksDir();
    if (!this.coachingPacksSeeded) {
      try {
        seedBundledCoachingPacks(packsDir, resolveBundledCoachingPacksDir());
      } catch (error) {
        gatewayLog.warn(
          "agent-coaching",
          `coaching pack seeding failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      this.coachingPacksSeeded = true;
    }
    return getActiveCoachingPack(packsDir);
  }

  /**
   * Install an org-distributed coaching-pack (FEA-2923 batch 5) via the
   * distribution/install path. Downloads + extracts the presigned asset zip and
   * copies/activates it through `installCoachingPackFromDistribution`, honoring
   * override precedence. Extraction uses adm-zip (loaded lazily so it never
   * costs anything on the seed/local path).
   */
  private async installCoachingDistribution(
    dist: DistributionDto
  ): Promise<CoachingInstallOutcome> {
    if (!this.isCoachingPacksEnabled()) {
      // Feature-flag off: the device's coaching state did NOT converge, so we
      // must NOT report "installed" (which `skipped` maps to). Report a distinct
      // `disabled` outcome that the installer maps to `pending`, matching the
      // "runtime not ready"/"not wired" precedent — the cloud only sees
      // "installed" when the pack genuinely landed.
      return { status: "disabled" };
    }
    const { default: AdmZip } = await import("adm-zip");
    return installCoachingDistribution(dist, {
      packsDir: this.coachingPacksDir(),
      coachingPackSlug,
      shouldHonorDistributionDefault,
      installCoachingPackFromDistribution,
      extractZip: (zipBytes, destDir) => {
        new AdmZip(zipBytes).extractAllTo(destDir, true);
      },
    });
  }

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

  /**
   * Wire the durable org-directory snapshot store (FEA-3457). Idempotent — the
   * cache layer resets its rehydrate guard on each configure, and the store is
   * scoped to the app's `userData` dir. Dynamically imported so electron-store
   * for this cache is loaded only alongside the dashboard runtime.
   */
  private async configureOrgDirectoryPersistence(): Promise<void> {
    const [
      { configureOrgDirectoryPersistence },
      { createOrgDirectoryPersistenceStore },
    ] = await Promise.all([
      import("./session/org-directory-cache.js"),
      import("./session/org-directory-persistence-store.js"),
    ]);
    configureOrgDirectoryPersistence(
      createOrgDirectoryPersistenceStore({
        cwd: app.getPath("userData"),
        // FEA-3517: surface a corrupt persisted directory shrinking boot-time
        // owner attribution to the main-process log (server-only discipline),
        // so the skip is diagnosable rather than a silent swallow.
        onCorruptEntriesDropped: ({ kept, dropped }) =>
          gatewayLog.warn(
            "org-directory",
            `Dropped ${dropped} malformed persisted org-directory user(s) on rehydrate; kept ${kept}.`
          ),
      })
    );
  }

  private async ensureAgentDashboardDesignSystemRuntime(): Promise<AgentDashboardDesignSystemRuntime | null> {
    // ISS-4714: a boot-time DB failure (migration refusal, etc.) is TERMINAL for
    // this process — the DB stays closed and DB IPC is disabled. Latch it so a
    // later caller (e.g. a branch-identity request) does not re-enter the init
    // try/catch below, which would re-run the doomed DB open AND re-emit the
    // one-per-boot app-exception telemetry event on every retry, inflating its
    // cardinality. The failure is surfaced once; further calls degrade to null.
    if (this.agentMonitorFailed) {
      return null;
    }
    if (!this.agentDashboardDesignSystem) {
      const result = await bootstrapAgentDashboardRuntime({
        goldenMode: this.goldenMode,
        desktopWindow: this.desktopWindow,
        rendererGates: this.rendererGates,
        settingsStore: this.settingsStore,
        appOtelRuntime: this.appOtelRuntime,
        agentSessionSync: this.agentSessionSync,
        requiredPluginInstaller: this.requiredPluginInstaller,
        getAuditService: () => this.getAuditService(),
        getTranscriptSync: () => this.transcriptSync,
        getApiKey: () => this.apiKeyStore.getApiKey(),
        getAccessToken: () => this.desktopSessionManager.getAccessToken(),
        hasDesktopSessionAuth: () =>
          this.desktopSessionManager.getState().status ===
          DesktopAuthStatus.Authenticated,
        getSessionIdentity: () => this.desktopSessionManager.getIdentity(),
        invalidateAccessToken: () =>
          this.desktopSessionManager.invalidateAccessToken(),
        getApiOrigin: () => this.settingsStore.getApiOrigin(),
        getProfileId: () => this.settingsStore.getActiveConfigId() ?? "legacy",
        getTraceCommentComputeTargetId: () =>
          this.getTraceCommentComputeTargetId(),
        getSyncComputeTargetId: () => this.onlineComputeTargetId(),
        getUserIdentity: () => this.traceCommentIdentityResolver.resolve(),
        // ISS-6243: the credential store sees a key set/rotated/cleared; the
        // resolver sees the cold-start `/me` landing. Both are needed.
        subscribeUserIdentityChanged: createUserIdentityChangeSubscription({
          apiKeyStore: this.apiKeyStore,
          identityResolver: this.traceCommentIdentityResolver,
        }),
        isSessionSyncAllowed: () =>
          this.syncEgressGate.sessionMetadataAllowed(),
        isSyncActivityChunkingSupported: () =>
          this.serverAgentSessionSyncCapabilities.activityChunking,
        notifySessionTerminal: (notice) => this.notifySessionTerminal(notice),
        onTerminalFailure: (reason) => {
          const notification = new Notification({
            title: "Closedloop Agent Monitor",
            body: reason,
          });
          notification.show();
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
        configureOrgDirectoryPersistence: () =>
          this.configureOrgDirectoryPersistence(),
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
   * Start the Agent Dashboard capture stack — hooks, collectors, and the
   * Routines scheduler. The DB runtime may already exist for renderer IPC.
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
    runtime.startHookListener();
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
    runtime.startCollectors();
    // PRD-566 / FEA-4348 (formerly FEA-3813): start the local crewd scheduler
    // daemon that backs Routines, gated on the `routines` flag (default off ⇒
    // the daemon never runs — a hard no-op). Runs in the db host; never blocks
    // capture startup.
    await this.maybeStartScheduler(runtime);
    // ISS-4717: capture startup does NOT start the sync lanes. The lanes are
    // started directly and unconditionally by `schedulePostInitialWindowBootTasks`
    // — see the rationale on that call — precisely so their start never depends
    // on this method's renderer/collector readiness waits. The removed branch
    // here awaited the UNBOUNDED `whenInitialCollectorImportComplete()`, which
    // has one producer (post-boot maintenance settling for the active
    // generation) and so never fires on a boot import the FEA-4156 watchdog gave
    // up on. Nothing reached it — every caller passed `startSessionSync: false`
    // — but it was a live re-gating hazard: restoring that argument, or adding a
    // caller that omits it, would have silently parked all four upload lanes for
    // the life of the process. `main/sync/AGENTS.md` invariant 9 is the rule.
  }

  /**
   * PRD-566 / FEA-4348 (formerly FEA-3813): start the crewd scheduler daemon
   * that backs Routines iff the `routines` flag is on. `requiresRestart` — the
   * flag is snapshotted here at boot. Failures are logged and swallowed so a
   * scheduler fault can never fail boot or capture.
   */
  private async maybeStartScheduler(
    runtime: AgentDashboardDesignSystemRuntime
  ): Promise<void> {
    if (
      this.shuttingDown ||
      !this.settingsStore.getFlag(DESKTOP_ROUTINES_FEATURE_FLAG_KEY)
    ) {
      return;
    }
    try {
      await runtime.startScheduler();
    } catch (error) {
      gatewayLog.warn(
        "scheduler",
        `Failed to start scheduled-tasks daemon: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async stopAgentCapture(
    options: { closeDesignSystem?: boolean } = {}
  ): Promise<void> {
    // FEA-3813 (PRD-553 M1): dispose the scheduler daemon (drains its in-flight
    // run + pending write-behinds). Idempotent and a no-op when the flag is off /
    // it never started; `close()` disposes it again as a backstop.
    await this.agentDashboardDesignSystem
      ?.stopScheduler()
      .catch(() => undefined);
    await this.agentDashboardDesignSystem?.stop();
    this.agentSessionSync.stop();
    this.agentComponentInvocationSync.stop();
    this.syncBurndownReporter.stop();
    this.transcriptSync?.stop();
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

    for (const channel of DESIGN_SYSTEM_DB_IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
    for (const channel of SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST) {
      ipcMain.removeHandler(channel);
    }
    for (const channel of SHARED_BRANCHES_IPC_CHANNEL_LIST) {
      ipcMain.removeHandler(channel);
    }
    // FEA-3814 (PRD-553 M2): the read-only Scheduled Tasks channels.
    for (const channel of SCHEDULED_TASKS_IPC_CHANNEL_LIST) {
      ipcMain.removeHandler(channel);
    }
    this.disabledAgentDashboardDbIpcRegistered = false;
  }

  openClaudeDashboard(): void {
    this.desktopWindow.show();
    this.desktopWindow.sendToRenderer("desktop:navigate-tab", "sessions");
  }

  private getActiveCommandKeyTargetContext():
    | ActiveCommandKeyTargetContext
    | undefined {
    return this.commandKeyLifecycle.getActiveTargetContext();
  }

  private setActiveCommandKeyTargetContext(computeTargetId: string): void {
    this.commandKeyLifecycle.setActiveTargetContext(computeTargetId);
  }

  private clearActiveCommandKeyTargetContext(reason: string): void {
    this.commandKeyLifecycle.clearTargetContext(reason);
  }

  private handleBrowserCommandKeyRevocationCommand(
    command: DesktopCommandEvent
  ): void {
    handleReservedBrowserCommandKeyRevocation(command, {
      removeAuthorizedKey: (fingerprint) =>
        this.authorizedCommandKeys.remove(fingerprint),
      getActiveTargetContext: () => this.getActiveCommandKeyTargetContext(),
      sendCommandAck: (event) => this.cloudSocket.sendCommandAck(event),
      sendCommandEvent: (event) => this.cloudSocket.sendCommandEvent(event),
      onChanged: () => this.commandSigningController.notifyCommandKeysChanged(),
      log: (level, message) => gatewayLog[level]("command-keys", message),
    });
  }

  private handleBrowserCommandKeyApprovalRequestCommand(
    command: DesktopCommandEvent
  ): void {
    handleReservedBrowserCommandKeyApprovalRequest(command, {
      notifyPendingKeys: (fingerprint) =>
        this.commandSigningController.notifyPendingCommandSigningKeyByFingerprint(
          fingerprint
        ),
      getActiveTargetContext: () => this.getActiveCommandKeyTargetContext(),
      onLegacyContextlessApproval: (fingerprint) => {
        this.commandKeyLifecycle.rememberLegacyContextlessApproval(fingerprint);
      },
      sendCommandAck: (event) => this.cloudSocket.sendCommandAck(event),
      sendCommandEvent: (event) => this.cloudSocket.sendCommandEvent(event),
      onChanged: () => this.commandSigningController.notifyCommandKeysChanged(),
      log: (level, message) => gatewayLog[level]("command-keys", message),
    });
  }

  private async handleGitHubResyncNudgeCommand(
    command: DesktopCommandEvent
  ): Promise<void> {
    await handleReservedGitHubResyncNudge(command, {
      getActiveTargetContext: () => this.getActiveCommandKeyTargetContext(),
      sendCommandAck: (event) => this.cloudSocket.sendCommandAck(event),
      sendCommandEvent: (event) => this.cloudSocket.sendCommandEvent(event),
      notifyRendererRefresh: async (body) => {
        const refresh =
          await this.agentDashboardDesignSystem?.refreshGitHubBranches(body);
        this.desktopWindow.sendToRenderer(
          "desktop:github-resync-nudge",
          refresh ?? { body, branchIds: [] }
        );
      },
      log: (level, message) => gatewayLog[level]("github-resync", message),
    });
  }

  private getLocalCapabilities(): ReturnType<
    typeof buildCommandSigningCapabilities
  > {
    return {
      ...buildCommandSigningCapabilities({
        commandSigningEnforcementEnabled:
          this.settingsStore.getCommandSigningEnforcementEnabled(),
      }),
      loopRunnerRefreshSupported: true,
      loopRunnerHeartbeatSupported: true,
    };
  }

  private isCommandSigningEnforced(): boolean {
    return shouldEnforceCommandSigning({
      serverCommandSigningSupported: this.serverCommandSigningSupported,
      commandSigningEnforcementEnabled:
        this.settingsStore.getCommandSigningEnforcementEnabled(),
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
      "desktop:update-status",
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
    // FEA-2099 test seam: under the fake-feed e2e the build is unsigned, so the
    // real binary swap (quitAndInstall) cannot apply and would hang — exactly
    // the wedge this guard exists to catch. Stub the swap at this boundary,
    // emit a deterministic marker (the "handoff reached, no hang" signal the
    // e2e asserts on), and let the normal quit proceed. The before-quit
    // handler has already run graceful cleanup, so reaching here proves the
    // FEA-2026 path completes. Unreachable in packaged builds.
    if (isFakeUpdateFeedActive(app.isPackaged)) {
      gatewayLog.info(
        "auto-update",
        "fake-feed: skipping real quitAndInstall (unsigned); handoff complete"
      );
      // stdout marker is consumed by the e2e via the main process stdout.
      process.stdout.write(`${FAKE_UPDATE_HANDOFF_MARKER}\n`);
      app.quit();
      return;
    }
    gatewayLog.info(
      "auto-update",
      "calling quitAndInstall(isSilent=true, isForceRunAfter=true)"
    );
    autoUpdater.quitAndInstall(true, true);
  }

  /**
   * FEA-2349: an update exists but cannot install because the app runs from a
   * read-only volume (App Translocation). Delegates to the
   * {@link UpdateBlockedController}, which owns the banner-error state, the
   * once-per-session native dialog, and the move-to-/Applications flow.
   */
  private handleUpdateInstallBlocked(version?: string): void {
    this.updateBlockedController.handleUpdateInstallBlocked(version);
  }

  private canMoveBlockedUpdateToApplications(): boolean {
    return this.updateBlockedController.canMoveBlockedUpdateToApplications();
  }

  private attemptMoveToApplications(): boolean {
    return this.updateBlockedController.attemptMoveToApplications();
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
      bootRecovery: this.bootRecovery,
      queueStatsTelemetryDebounce: this.queueStatsTelemetryDebounce,
      clearActiveCommandKeyTargetContext: (reason) =>
        this.clearActiveCommandKeyTargetContext(reason),
      commandKeyReconciler: this.commandKeyReconciler,
      disposeOrgSyncPolicySubscription: () => {
        this.orgSyncPolicySubscription?.dispose();
        this.orgSyncPolicySubscription = null;
      },
      orgSyncPolicyStore: this.orgSyncPolicyStore,
      stopAgentCapture: () => this.stopAgentCapture(),
      costReconciliation: this.costReconciliation,
      transcriptSync: this.transcriptSync,
      appLifecycleTelemetry: this.appLifecycleTelemetry,
      appOtelRuntime: this.appOtelRuntime,
      unregisterDisabledAgentDashboardDbIpcHandlers: () =>
        this.unregisterDisabledAgentDashboardDbIpcHandlers(),
      getUpdateCheckTimer: () => this.updateCheckTimer,
      clearUpdateCheckTimer: () => {
        if (this.updateCheckTimer) {
          clearInterval(this.updateCheckTimer);
          this.updateCheckTimer = null;
        }
      },
      cloudSocket: this.cloudSocket,
      commandExecutor: this.commandExecutor,
      server: this.server,
      desktopWindow: this.desktopWindow,
      tray: this.tray,
      isApplyingUpdate: () => this.applyingDownloadedUpdate,
      log: (message) => gatewayLog.info("shutdown", message),
      logWarning: (tag, message) => gatewayLog.warn(tag, message),
    });
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

  private onCloudSocketStatus(status: CloudSocketStatus): void {
    if (!this.cloudConnectionEnabled) {
      this.cloudStatus = {
        state: "degraded",
        error: "Cloud connection disabled by user",
      };
      this.agentSessionSync.refresh();
      this.agentComponentInvocationSync.refresh();
      this.refreshTrayState();
      return;
    }

    this.cloudStatus = status;
    this.agentSessionSync.refresh();
    this.agentComponentInvocationSync.refresh();
    const stats = this.commandExecutor.getStats();

    if (status.state === "online") {
      if (this.serverCommandSigningSupported) {
        this.commandKeyReconciler.start();
      }
      this.persistActiveConfigManagedMetadata({
        lastComputeTargetId: status.targetId,
      });
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
      // FEA-4169: refresh the org sync policy on each cloud-online transition so
      // the outer gate reflects the current server-owned org policy before the
      // sync lanes tick. Best-effort; failure keeps the last-known state.
      void this.orgSyncPolicyStore.refresh();
      // FEA-2923 (T-16.10): trigger distribution reconciliation on each cloud
      // online transition so newly assigned distributions get auto-installed.
      void this.requiredPluginInstaller.reconcile(status.targetId);
      return;
    }

    this.commandExecutor.setConnected(false);
    this.serverCommandSigningSupported = false;
    this.clearActiveCommandKeyTargetContext(`cloud_status_${status.state}`);
    this.commandKeyReconciler.stop();

    if (status.state === "degraded") {
      Observability.connectionDegraded(status.error);
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
    const presenceState =
      this.cloudStatus.state === "online" &&
      !paused &&
      this.recovery.gatewayHealthy
        ? "online"
        : "degraded";
    this.cloudSocket.sendPresence({
      state: presenceState,
      ...(paused ? { error: "cloud commands paused by user" } : {}),
      activeCommands: stats.activeCommands,
      queueDepth: stats.queueDepth,
    });
  }

  private setCloudConnectionEnabled(enabled: boolean): void {
    if (this.goldenMode) {
      // FEA-2648: golden mode hard-disables cloud egress — the toggle is inert
      // and must not flip persisted or in-memory state.
      return;
    }
    this.cloudSocketStartup.invalidate();
    this.cloudConnectionEnabled = enabled;
    this.settingsStore.setCloudConnectionEnabled(enabled);
    if (!enabled) {
      this.cloudSocket.stop();
      this.serverCommandSigningSupported = false;
      this.clearActiveCommandKeyTargetContext("cloud_connection_disabled");
      this.commandKeyReconciler.stop();
      this.cloudStatus = {
        state: "degraded",
        error: "Cloud connection disabled by user",
      };
      this.agentSessionSync.refresh();
      this.agentComponentInvocationSync.refresh();
      this.refreshTrayState();
      return;
    }

    this.cloudStatus = { state: "idle" };
    this.agentSessionSync.refresh();
    this.agentComponentInvocationSync.refresh();
    this.refreshTrayState();
    this.cloudSocket.restart();
  }

  /**
   * FEA-3907 — apply a graduated data sync level: persist it as the SSOT (level
   * + derived booleans + tier via `settingsStore.setDataSyncLevel`) and reconcile
   * the in-memory connectivity state through the existing per-flag setters so the
   * cloud socket, tray, and presence side effects match a manual toggle. The
   * derived `cloudConnectionEnabled` / `cloudCommandsPaused` values drive
   * `setCloudConnectionEnabled` / `setCloudCommandsPaused`; the store write also
   * persists `transcriptSyncEnabled` and `syncObservabilityTier` for their own
   * consumers (TranscriptSyncService, the sync-tier gates).
   *
   * Golden mode (FEA-2648) hard-disables cloud egress and must never flip the
   * persisted or in-memory `cloudConnectionEnabled` to `true`. `setDataSyncLevel`
   * would persist `true` for any non-Off level, so in golden mode we force the
   * persisted connection flag back to `false` after the SSOT write, mirroring the
   * settings-IPC golden-mode guard (`buildNextUpdatePartial`). The in-memory
   * `setCloudConnectionEnabled` is already inert in golden mode.
   */
  private applyDataSyncLevel(level: DataSyncLevel): void {
    const derived = dataSyncLevelToBooleans(level);
    // SSOT write first: level + all four derived values land together so a crash
    // between the calls below can never leave the level and its flags disagreeing.
    this.settingsStore.setDataSyncLevel(level);
    if (this.goldenMode && derived.cloudConnectionEnabled) {
      // Golden mode never enables cloud egress; keep the persisted connection
      // flag hard-disabled even though the level would otherwise turn it on.
      this.settingsStore.setCloudConnectionEnabled(false);
    }
    // Reconcile in-memory app state + fire side effects. These re-persist the two
    // connectivity flags to the same values just written — idempotent — but own
    // the socket/tray/presence bookkeeping. In golden mode the connection setter
    // is inert (cloud egress stays hard-disabled), matching a manual toggle.
    this.setCloudCommandsPaused(derived.cloudCommandsPaused);
    this.setCloudConnectionEnabled(derived.cloudConnectionEnabled);
    this.reconcileTranscriptSyncLane(derived.transcriptSyncEnabled);
  }

  /**
   * FEA-3907: `this.transcriptSync` is constructed once at boot from the
   * then-persisted `transcriptSyncEnabled` (FEA-2715, restart-scoped), so a level
   * that turns the transcript lane on live would otherwise persist the flag but
   * leave the lane object `null` — silently no-op'ing the archive it claims to
   * enable until the next restart. Lazily construct + start it the first time a
   * level enables the lane this session so the choice takes effect immediately.
   * Golden mode never runs cloud egress, so the lane stays null there (matching
   * the boot guard). We never tear the lane down on a lower level: its own tick
   * already no-ops when `isEnabled()` (live `transcriptSyncEnabled`) goes false.
   */
  private reconcileTranscriptSyncLane(transcriptSyncEnabled: boolean): void {
    const laneUnavailable =
      !transcriptSyncEnabled || this.goldenMode || this.shuttingDown;
    if (laneUnavailable || this.transcriptSync) {
      return;
    }
    this.transcriptSync = this.createTranscriptSyncService();
    this.transcriptSync.start();
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
    this.serverCommandSigningSupported = false;
    this.clearActiveCommandKeyTargetContext("cloud_socket_restart");
    this.commandKeyReconciler.stop();
    this.agentSessionSync.refresh();
    this.agentComponentInvocationSync.refresh();
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
  private notifyRendererDevUpdateReady(): void {
    this.desktopWindow.sendToRenderer(
      "desktop:update-status",
      DEV_UPDATE_READY_STATUS
    );
  }

  private async applyUpdate(): Promise<void> {
    await applyDevUpdate(this.repoRoot());
  }

  private reconcileJobStore(): LocalJob[] {
    return reconcileJobStoreOnBoot(this.jobStore);
  }

  private registerIpcHandlers(): void {
    registerDesktopIpcHandlers({
      activityLog: this.activityLog,
      agentSessionSync: this.agentSessionSync,
      apiKeyStore: this.apiKeyStore,
      approvalEvaluator: this.approvalEvaluator,
      approvalStore: this.approvalStore,
      appOtelRuntime: this.appOtelRuntime,
      authorizedCommandKeys: this.authorizedCommandKeys,
      claudeCodeAnalytics: this.claudeCodeAnalytics,
      cloudSocket: this.cloudSocket,
      cloudSocketStartup: this.cloudSocketStartup,
      commandKeyLifecycle: this.commandKeyLifecycle,
      commandKeyReconciler: this.commandKeyReconciler,
      commandSigningController: this.commandSigningController,
      costReconciliation: this.costReconciliation,
      desktopSessionManager: this.desktopSessionManager,
      desktopWindow: this.desktopWindow,
      docsHelp: this.docsHelp,
      gatewaySigningKeyStore: this.gatewaySigningKeyStore,
      jobStore: this.jobStore,
      legacyGatewayId: this.legacyGatewayId,
      managedOnboarding: this.managedOnboarding,
      recovery: this.recovery,
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
      attemptMoveToApplications: () => this.attemptMoveToApplications(),
      canMoveBlockedUpdateToApplications: () =>
        this.canMoveBlockedUpdateToApplications(),
      checkForUpdate: () => this.checkForUpdate(),
      coachingPacksDir: () => this.coachingPacksDir(),
      getActiveCoachingPackSeeded: () => this.getActiveCoachingPackSeeded(),
      getAgentDashboardRuntime: () => this.agentDashboardDesignSystem,
      getAgentMonitorRuntimeStatus: () => this.agentMonitorRuntimeStatus,
      getAgentMonitorUrl: () => this.getAgentMonitorUrl(),
      getAuditService: () => this.getAuditService(),
      getCloudCommandsPaused: () => this.cloudCommandsPaused,
      getCloudConnectionEnabled: () => this.cloudConnectionEnabled,
      getCloudStatus: () => this.cloudStatus,
      getConnectionSecurityStatus: () => this.getConnectionSecurityStatus(),
      getDangerousAutoApprove: () => this.dangerousAutoApprove,
      getGatewayAuthToken: () => this.gatewayAuthToken,
      getLocalSessionSourceStatus: () => this.getLocalSessionSourceStatus(),
      getPackagedUpdateState: () => this.packagedUpdateState,
      getPackagedUpdateStatusPayload: () =>
        this.getPackagedUpdateStatusPayload(),
      getServerCommandSigningSupported: () =>
        this.serverCommandSigningSupported,
      getTraceCommentComputeTargetId: () =>
        this.getTraceCommentComputeTargetId(),
      getTranscriptSync: () => this.transcriptSync,
      guardUpdateDownload: (result) => this.guardUpdateDownload(result),
      isAgentCoachingTipsEnabled: () => this.isAgentCoachingTipsEnabled(),
      isAgentMonitorReady: () => this.isAgentMonitorReady(),
      isCoachingPacksEnabled: () => this.isCoachingPacksEnabled(),
      isDebugAuthEnabled: () => this.isDebugAuthEnabled(),
      isGoldenMode: () => this.goldenMode !== null,
      isLocalSessionSourceReady: () => this.isLocalSessionSourceReady(),
      isPlanExtractionEnabled: () => this.isPlanExtractionEnabled(),
      isShuttingDown: () => this.shuttingDown,
      notifyInitialRendererLiveDbIdle: () =>
        this.rendererGates.notifyInitialRendererLiveDbIdle(),
      notifyPackagedUpdateStatus: () => this.notifyPackagedUpdateStatus(),
      notifyRendererUserInput: () =>
        this.rendererGates.notifyRendererUserInput(),
      openClaudeDashboard: () => this.openClaudeDashboard(),
      persistActiveProfileKey: (apiKey, provenance) =>
        this.persistActiveProfileKey(apiKey, provenance),
      refreshTrayState: (explicitDetails) =>
        this.refreshTrayState(explicitDetails),
      restartCloudSocket: () => this.restartCloudSocket(),
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
      transcriptStateDir: () => this.transcriptStateDir(),
      yieldToMainLoop: () => yieldToMainLoop(),
    });
  }

  private signDesktopRequest(
    request: DesktopPopSigningRequest
  ): DesktopPopHeaders | null {
    const activeGatewayId = this.getActiveGatewayId();
    const keyPair = this.gatewaySigningKeyStore.load(activeGatewayId);
    if (!keyPair.ok) {
      throw new DesktopPopUnavailableError(keyPair.reason);
    }
    try {
      return signDesktopPopHeaders({
        ...request,
        gatewayId: activeGatewayId,
        privateKeyPkcs8Pem: keyPair.keyPair.privateKeyPkcs8Pem,
      });
    } catch {
      throw new DesktopPopUnavailableError("sign_failed");
    }
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
}

const MAX_IN_FLIGHT_COMMANDS = 2;
const QUEUE_STATS_DEBOUNCE_MS = 1000;
