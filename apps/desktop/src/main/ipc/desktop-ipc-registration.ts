import { app, ipcMain, safeStorage, shell, type WebContents } from "electron";
import pkg from "electron-updater";
import type { DesktopGatewayServer } from "../../server/server.js";
import type { AgentMonitorRuntimeStatus } from "../../shared/agent-monitor-status.js";
import {
  AuditIpcChannel,
  type AuditProgressPayload,
} from "../../shared/audit-contract.js";
import type { CoachingPackInfo } from "../../shared/coaching-pack-contract.js";
import type { ConnectionSecurityStatus } from "../../shared/connection-security.js";
import {
  type DataSyncLevel,
  DEFAULT_DESKTOP_SETTINGS,
  type SavedConfig,
} from "../../shared/contracts.js";
import { DESKTOP_AUDIT_BOT_FEATURE_FLAG_KEY } from "../../shared/feature-flags.js";
import { GATEWAY_DISPATCH_CHANNEL } from "../../shared/gateway-dispatch-channel.js";
import type { LocalSessionSourceStatus } from "../../shared/local-session-source-status.js";
import { RENDERER_OTEL_EXPORT_CHANNEL } from "../../shared/renderer-otel-bridge-constants.js";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
} from "../../shared/transcript-sync-status-contract.js";
import {
  isAgentMonitorHooksEnabled,
  setAgentMonitorHooksEnabled,
} from "../agent-monitor/agent-monitor-hooks.js";
import type { AgentSessionSyncService } from "../agent-sync/agent-session-sync-service.js";
import { refreshApplicationMenu } from "../app-menu.js";
import { pruneExpiredAlwaysAllowRules } from "../approvals/always-allow-rules.js";
import type { ApprovalEvaluator } from "../approvals/approval-evaluator.js";
import type { ApprovalStore } from "../approvals/approval-store.js";
import type { AuditService } from "../audit/audit-service.js";
import type { LocalSessionStore } from "../auth/local-session-store.js";
import type { CloudSocketStatus } from "../cloud/cloud-protocol.js";
import type { CloudSocketService } from "../cloud/cloud-socket.js";
import type { CloudSocketStartupCoordinator } from "../cloud/cloud-socket-startup.js";
import type { AuthorizedCommandKeyStore } from "../command-signing/authorized-command-key-store.js";
import {
  type BrowserCommandKeyAppLifecycle,
  resetBrowserCommandKeyProfileState,
} from "../command-signing/command-key-app-lifecycle.js";
import type { CommandKeyReconciler } from "../command-signing/command-key-reconciler.js";
import type { CommandSigningController } from "../command-signing/command-signing-controller.js";
import type { GatewaySigningKeyStore } from "../command-signing/gateway-signing-key-store.js";
import type { ClaudeCodeAnalyticsService } from "../cost/claude-code-analytics-service.js";
import type { CostReconciliationService } from "../cost/cost-reconciliation-service.js";
import type { AgentDashboardDesignSystemRuntime } from "../dashboard/agent-dashboard-design-system-runtime.js";
import type { ActivityLogStore } from "../diagnostics/activity-log-store.js";
import type { DocsHelpService } from "../docs-help/docs-bundle.js";
import type { JobStore } from "../jobs/job-store.js";
import type { GatewayRecoveryManager } from "../lifecycle/gateway-recovery.js";
import type { RendererReadinessGates } from "../lifecycle/renderer-readiness-gates.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  getMainLogFilePath,
  openMainLogFile,
} from "../logging/persistent-log.js";
import type { ManagedOnboardingController } from "../onboarding/managed-onboarding-controller.js";
import { registerPackAnalyticsIpc } from "../packs/pack-analytics-ipc.js";
import type { RequiredPluginInstaller } from "../packs/required-plugin-installer.js";
import { withIpcProfiling } from "../profiling/ipc-profiling.js";
import {
  getIpcProfilingSink,
  getRenderCommitProfilingSink,
} from "../profiling/main-profiling-session.js";
import type { DesktopSessionManager } from "../session/desktop-session-manager.js";
import { registerSessionLimitsIpcHandlers } from "../session-limits-ipc.js";
import type { ApiKeyStore } from "../settings/api-key-store.js";
import { normalizeAndValidateOrigin } from "../settings/origin-policy.js";
import { seedReposConfig } from "../settings/seed-repos-config.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { SyncBurndownReporter } from "../sync/sync-burndown-reporter.js";
import type { DesktopOtelRuntime } from "../telemetry/app-otel-runtime.js";
import type { TelemetryOrgProvider } from "../telemetry/telemetry-org-identity.js";
import { resolveTranscriptCacheDir } from "../transcript/transcript-read-cache.js";
import {
  createLocalTranscriptResolverDeps,
  resolveLocalTranscriptPath,
} from "../transcript-sync/local-transcript-path-resolver.js";
import { kickTranscriptSweepAfterTierChange } from "../transcript-sync/transcript-sweep-kick.js";
import type { TranscriptSyncService } from "../transcript-sync/transcript-sync-service.js";
import { resolveTrustedClaudeTranscriptPath } from "../transcript-sync/trusted-transcript-path.js";
import type {
  PackagedUpdateState,
  PackagedUpdateStatusPayload,
} from "../update/packaged-update-state.js";
import type { DesktopWindow } from "../window.js";
import { registerAgentMonitorIpcHandlers } from "./agent-monitor-ipc.js";
import { registerApiKeyIpcHandlers } from "./api-key-ipc.js";
import { registerApprovalsIpcHandlers } from "./approvals-ipc.js";
import { registerAuditIpcHandlers } from "./audit-ipc.js";
import {
  type BinaryPathPatch,
  type CliBinaryTool,
  registerBinaryPathsIpcHandlers,
} from "./binary-paths-ipc.js";
import { registerCloudApiFetchIpcHandler } from "./cloud-api-fetch-ipc.js";
import { registerCloudControlIpcHandlers } from "./cloud-control-ipc.js";
import {
  buildCloudReadReadinessProjectorDeps,
  createCloudReadReadinessProjector,
} from "./cloud-read-readiness-projection.js";
import { registerCoachingIpcHandlers } from "./coaching-ipc.js";
import { registerCommandSigningKeysIpcHandlers } from "./command-signing-keys-ipc.js";
import { registerCostReconciliationIpcHandlers } from "./cost-reconciliation-ipc.js";
import { registerDebugIpcHandlers } from "./debug-ipc.js";
import { registerDesktopAuthIpcHandlers } from "./desktop-auth-ipc.js";
import { registerDesktopExistingUserIpcHandlers } from "./desktop-existing-user-ipc.js";
import { registerDesktopIdentityIpcHandlers } from "./desktop-identity-ipc.js";
import { registerDocsHelpIpcHandlers } from "./docs-help-ipc.js";
import { createGatewayDispatchHandler } from "./gateway-dispatch-ipc.js";
import { registerGitHubConnectOpenerIpcHandlers } from "./github-connect-opener-ipc.js";
import { registerJobsIpcHandlers } from "./jobs-ipc.js";
import { registerLogsActivityIpcHandlers } from "./logs-activity-ipc.js";
import { registerManagedKeyHintIpcHandlers } from "./managed-key-hint-ipc.js";
import { registerMoveToApplicationsIpcHandler } from "./move-to-applications-ipc.js";
import { registerOnboardingIpcHandlers } from "./onboarding-ipc.js";
import { registerProfileConfigIpcHandlers } from "./profile-config-ipc.js";
import { registerRendererLifecycleIpcHandlers } from "./renderer-lifecycle-ipc.js";
import { createRendererOtelExportHandler } from "./renderer-otel-ipc.js";
import { registerRuntimeInfoIpcHandlers } from "./runtime-info-ipc.js";
import { registerSandboxIpcHandlers } from "./sandbox-ipc.js";
import { registerSettingsIpcHandlers } from "./settings-ipc.js";
import { registerTranscriptForceArchiveIpcHandler } from "./transcript-force-archive-ipc.js";
import { registerTranscriptReadIpcHandler } from "./transcript-read-ipc.js";
import { registerUpdateIpcHandlers } from "./update-ipc.js";

const { autoUpdater } = pkg;

/**
 * Everything the main-process IPC surface needs from {@link DesktopApplication}.
 *
 * Collaborators are passed by reference; every piece of live application state
 * (cloud status, packaged-update state, the transcript lane, the agent-dashboard
 * runtime) is read through a getter so the handlers observe the same live field
 * the application owns — exactly what the previous inline `() => this.x`
 * callbacks did.
 */
export type DesktopIpcRegistrationDeps = {
  activityLog: ActivityLogStore;
  agentSessionSync: AgentSessionSyncService;
  apiKeyStore: ApiKeyStore;
  approvalEvaluator: ApprovalEvaluator;
  approvalStore: ApprovalStore;
  appOtelRuntime: DesktopOtelRuntime;
  authorizedCommandKeys: AuthorizedCommandKeyStore;
  claudeCodeAnalytics: ClaudeCodeAnalyticsService;
  cloudSocket: CloudSocketService;
  cloudSocketStartup: CloudSocketStartupCoordinator;
  commandKeyLifecycle: BrowserCommandKeyAppLifecycle;
  commandKeyReconciler: CommandKeyReconciler;
  commandSigningController: CommandSigningController;
  costReconciliation: CostReconciliationService;
  desktopSessionManager: DesktopSessionManager;
  desktopWindow: DesktopWindow;
  docsHelp: DocsHelpService;
  gatewaySigningKeyStore: GatewaySigningKeyStore;
  jobStore: JobStore;
  legacyGatewayId: string;
  managedOnboarding: ManagedOnboardingController;
  recovery: GatewayRecoveryManager;
  /**
   * The boot readiness gates. Read for `isInitialCollectorImportComplete()` —
   * "has the initial parse/import backlog finished?" — which drives both the
   * sidebar's dashboard-ready affordance and the ISS-5477 read-source hold.
   */
  rendererGates: RendererReadinessGates;
  requiredPluginInstaller: RequiredPluginInstaller;
  server: DesktopGatewayServer;
  sessionStore: LocalSessionStore;
  settingsStore: SettingsStore;
  /**
   * ISS-5387's burn-down observer. ISS-5477 reads its latest sample to decide
   * whether the renderer may move its read source to the cloud; the sample is
   * `null` — UNKNOWN, never drained — before the first pass, after the reporter
   * stops, and when the compute target has changed since it was taken.
   */
  syncBurndownReporter: SyncBurndownReporter;
  telemetryOrgProvider: TelemetryOrgProvider;

  applyBinaryPathPatch: (
    patch: BinaryPathPatch
  ) => Partial<Record<CliBinaryTool, string>>;
  applyDataSyncLevel: (level: DataSyncLevel) => void;
  applyUpdate: () => Promise<void>;
  attemptMoveToApplications: () => boolean;
  canMoveBlockedUpdateToApplications: () => boolean;
  checkForUpdate: () => Promise<{
    updateAvailable: boolean;
    currentHash: string;
    remoteHash: string;
  }>;
  coachingPacksDir: () => string;
  getActiveCoachingPackSeeded: () => CoachingPackInfo | null;
  getAgentDashboardRuntime: () => AgentDashboardDesignSystemRuntime | null;
  getAgentMonitorRuntimeStatus: () => AgentMonitorRuntimeStatus;
  getAgentMonitorUrl: () => string | null;
  getAuditService: () => AuditService;
  getCloudCommandsPaused: () => boolean;
  getCloudConnectionEnabled: () => boolean;
  getCloudStatus: () => CloudSocketStatus;
  getConnectionSecurityStatus: () => ConnectionSecurityStatus;
  getDangerousAutoApprove: () => boolean;
  getGatewayAuthToken: () => string;
  getLocalSessionSourceStatus: () => LocalSessionSourceStatus;
  getPackagedUpdateState: () => PackagedUpdateState;
  getPackagedUpdateStatusPayload: () => PackagedUpdateStatusPayload;
  getServerCommandSigningSupported: () => boolean;
  getTraceCommentComputeTargetId: () => string | null;
  getTranscriptSync: () => TranscriptSyncService | null;
  guardUpdateDownload: (
    result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
  ) => void;
  isAgentCoachingTipsEnabled: () => boolean;
  isAgentMonitorReady: () => boolean;
  isCoachingPacksEnabled: () => boolean;
  isDebugAuthEnabled: () => boolean;
  isGoldenMode: () => boolean;
  isLocalSessionSourceReady: () => boolean;
  isPlanExtractionEnabled: () => boolean;
  isShuttingDown: () => boolean;
  notifyInitialRendererLiveDbIdle: () => void;
  notifyPackagedUpdateStatus: () => void;
  notifyRendererUserInput: () => void;
  openClaudeDashboard: () => void;
  persistActiveProfileKey: (
    apiKey: string,
    provenance: "USER_CREATED" | "DESKTOP_MANAGED"
  ) => void;
  refreshTrayState: (explicitDetails?: string) => void;
  restartCloudSocket: () => void;
  setApplyingDownloadedUpdate: (value: boolean) => void;
  setCloudCommandsPaused: (paused: boolean) => void;
  setCloudConnectionEnabled: (enabled: boolean) => void;
  setDangerousAutoApprove: (enabled: boolean) => void;
  setPackagedUpdateState: (patch: Partial<PackagedUpdateState>) => void;
  transcriptStateDir: () => string;
  yieldToMainLoop: () => Promise<void>;
};

/**
 * Register every main-process IPC handler the desktop app owns.
 *
 * Called once, through {@link registerDesktopIpcHandlers}. Grouped registration
 * lives in the per-domain `ipc/*-ipc.ts` modules; this is the wiring seam that
 * binds them to application state.
 *
 * Sender trust (`desktopWindow.isTrustedSender`) is the security boundary for
 * the handler groups that receive it below. Two registrars are deliberately
 * ungated and read no renderer input: `registerLogsActivityIpcHandlers`
 * (local log/activity reads) and `registerManagedKeyHintIpcHandlers`
 * (main-process-sourced hint state). Any new renderer-facing channel that
 * accepts renderer input or mutates state must take `isTrustedSender`.
 */
function registerAllDesktopIpcHandlers(deps: DesktopIpcRegistrationDeps): void {
  const isTrustedSender = (sender: WebContents) =>
    deps.desktopWindow.isTrustedSender(sender);

  registerRendererLifecycleIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => deps.desktopWindow.isTrustedSender(sender),
    handleRendererReady: (sender, phase) =>
      deps.desktopWindow.handleRendererReady(sender, phase),
    yieldToMainLoop: () => deps.yieldToMainLoop(),
    isShuttingDown: () => deps.isShuttingDown(),
    isLocalSessionSourceReady: () => deps.isLocalSessionSourceReady(),
    notifyInitialRendererLiveDbIdle: () =>
      deps.notifyInitialRendererLiveDbIdle(),
    notifyRendererUserInput: () => deps.notifyRendererUserInput(),
  });
  // Engineer gateway transport (M-001): the renderer's desktop
  // SurfaceRoutingAdapter dispatches `/api/gateway/*` overlay reads here. The
  // handler is fail-closed (sender trust + exact-path allowlist + main-held
  // auth) and loops back to the in-process gateway server, reusing the full
  // router/operation/guard stack. SECURITY-CRITICAL — see gateway-dispatch-ipc.ts.
  ipcMain.handle(
    GATEWAY_DISPATCH_CHANNEL,
    createGatewayDispatchHandler({
      isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
      getActivePort: () => deps.server.getActivePort(),
      getGatewayAuthToken: () => deps.getGatewayAuthToken(),
      log: gatewayLog,
    })
  );
  ipcMain.handle(
    RENDERER_OTEL_EXPORT_CHANNEL,
    createRendererOtelExportHandler({
      isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
      runtime: deps.appOtelRuntime,
      // ISS-4430: `null` unless CLOSEDLOOP_PROFILE_DIR is set. The handler treats
      // an absent sink as "no tap" and behaves exactly as it did before, so this
      // injection is inert in production.
      profilingSink: getRenderCommitProfilingSink() ?? undefined,
    })
  );
  registerMoveToApplicationsIpcHandler(ipcMain, {
    canMoveToApplications: () => deps.canMoveBlockedUpdateToApplications(),
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    moveToApplications: () => deps.attemptMoveToApplications(),
  });
  // FEA-3843 / PRD-555 (M1): read-only in-app Docs & Help lookups over the
  // build-time docs bundle + local search index. Always registered (the
  // renderer surfaces stay gated on the `docsHelp` Labs flag); sender trust is
  // the security boundary.
  registerDocsHelpIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    docsHelp: deps.docsHelp,
  });
  registerRuntimeInfoIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getAppVersion: () => app.getVersion(),
    getIsPackaged: () => app.isPackaged,
    settingsStore: deps.settingsStore,
    authorizedCommandKeys: deps.authorizedCommandKeys,
    getTranscriptSyncStatus: async () =>
      (await deps.getTranscriptSync()?.getStatusSnapshot()) ?? {
        // No transcript-sync service at all (the toggle was off at boot, or
        // golden mode). Nothing can egress, so every gate reads closed —
        // `enabled: false` is what a consumer keys the "you turned it off"
        // state on, and the other two stay closed rather than implying a
        // healthy lane behind a missing service (ISS-4716). The gate is a
        // settled `Denied`, not `Unresolved`: there is no service and no
        // pending policy read here, so nothing is going to arrive later and a
        // consumer must not sit on a skeleton waiting for it (ISS-5348).
        enabled: false,
        online: false,
        tierGate: TranscriptEgressGate.Denied,
        storeReady: false,
        statusCounts: emptyTranscriptStatusCounts(),
      },
    getActivePort: () => deps.server.getActivePort(),
    getCloudStatus: () => deps.getCloudStatus(),
    getCloudCommandsPaused: () => deps.getCloudCommandsPaused(),
    getCloudConnectionEnabled: () => deps.getCloudConnectionEnabled(),
    getConnectionSecurityStatus: () => deps.getConnectionSecurityStatus(),
    getServerCommandSigningSupported: () =>
      deps.getServerCommandSigningSupported(),
    isServerAlive: () => deps.server.isAlive(),
    getGatewayHealthy: () => deps.recovery.gatewayHealthy,
    getIngestProgress: () =>
      deps.getAgentDashboardRuntime()?.getIngestProgress() ?? null,
    // FEA-3639: empty when the runtime isn't up yet — no blocks to report
    // before the collectors exist, so degrade to none.
    getFileAccessBlocks: () =>
      deps.getAgentDashboardRuntime()?.getFileAccessBlocks() ?? [],
    getMaintenanceProgress: () =>
      deps.getAgentDashboardRuntime()?.getMaintenanceProgress() ?? null,
    getCloudSyncProgress: () => deps.agentSessionSync.getSyncProgress(),
    getDashboardReady: () =>
      deps.rendererGates.isInitialCollectorImportComplete(),
    getAgentMonitorStatus: () => deps.getAgentMonitorRuntimeStatus(),
    // ISS-5477: project the ISS-5387 burn-down's latest sample into the
    // read-source payload. Both the projection's rules AND the binding of its
    // getters to these stores live in `cloud-read-readiness-projection.ts`, so
    // each is executed by a node test instead of being reachable only through
    // an Electron boot. Keep this call `(deps)` — a hand-rolled object literal
    // here would put the binding back out of reach.
    getCloudReadReadiness: createCloudReadReadinessProjector(
      buildCloudReadReadinessProjectorDeps(deps)
    ),
  });
  registerCoachingIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    isAgentCoachingTipsEnabled: () => deps.isAgentCoachingTipsEnabled(),
    isCoachingPacksEnabled: () => deps.isCoachingPacksEnabled(),
    getActiveCoachingPackSeeded: () => deps.getActiveCoachingPackSeeded(),
    coachingPacksDir: () => deps.coachingPacksDir(),
    getTraceCommentComputeTargetId: () => deps.getTraceCommentComputeTargetId(),
    installCoachingDistributionById: (computeTargetId, distributionId) =>
      deps.requiredPluginInstaller.installCoachingDistributionById(
        computeTargetId,
        distributionId
      ),
    // FEA-4050: durably persist an opt-in-pack decline so the reconcile does
    // not re-surface the dismissed pack after an app restart.
    declineDistributionById: (computeTargetId, distributionId) =>
      deps.requiredPluginInstaller.declineDistributionById(
        computeTargetId,
        distributionId
      ),
    // FEA-4050: not-connected (no compute target) decline path. Persist the
    // id-only decline unscoped (no computeTargetId) so it suppresses the pack
    // the banner already surfaced, across restarts, until the cloud
    // reconnects and a connected decline can scope + enrich it.
    recordDeclinedDistributionId: (distributionId) =>
      deps.settingsStore.recordDeclinedDistribution({
        distributionId,
        catalogItemId: "",
        organizationId: "",
      }),
    // ISS-5123: pre-install revalidation so a withdrawn offer still showing in
    // the banner cannot be accepted.
    assertDistributionAssigned: (computeTargetId, distributionId) =>
      deps.requiredPluginInstaller.assertDistributionAssigned(
        computeTargetId,
        distributionId
      ),
  });
  // FEA-3847 (PRD-556 M1): on-demand Audit Bot. Runs a crewd review character
  // (Docs Darwin) against the open repo via the harness cascade, streaming
  // progress to the renderer. Fail-closed: the handler asserts sender trust and
  // gates on the `auditBot` Labs flag before AuditService spawns anything; the
  // repo path is sandbox-validated inside the service. SECURITY-CRITICAL.
  registerAuditIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    isAuditBotEnabled: () =>
      deps.settingsStore.getFlag(DESKTOP_AUDIT_BOT_FEATURE_FLAG_KEY),
    auditService: deps.getAuditService(),
    sendProgress: (payload: AuditProgressPayload) =>
      deps.desktopWindow.sendToRenderer(AuditIpcChannel.Progress, payload),
  });
  // Desktop-team overlay: the renderer fetches a pack's org-wide analytics
  // through main (renderers have no cloud REST access), signed with the
  // device token.
  registerPackAnalyticsIpc({
    getAccessToken: () => deps.desktopSessionManager.getAccessToken(),
    getApiOrigin: () => deps.settingsStore.getApiOrigin(),
    isTrustedSender: (sender) => deps.desktopWindow.isTrustedSender(sender),
  });
  registerAgentMonitorIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getAgentMonitorUrl: () => deps.getAgentMonitorUrl(),
    isAgentMonitorReady: () => deps.isAgentMonitorReady(),
    isPlanExtractionEnabled: () => deps.isPlanExtractionEnabled(),
    getLocalSessionSourceStatus: () => deps.getLocalSessionSourceStatus(),
    setImportPaused: (paused) =>
      deps.getAgentDashboardRuntime()?.setImportPaused(paused),
    // Return the restart promise so the ReimportAgentSessions handler resolves
    // only once the restart has run (the Reload button awaits it). Undefined
    // when the runtime isn't up yet — nothing to restart, resolve immediately.
    restartCollectors: () =>
      deps.getAgentDashboardRuntime()?.restartCollectors(),
    openClaudeDashboard: () => deps.openClaudeDashboard(),
    isHooksEnabled: () => isAgentMonitorHooksEnabled(),
    setHooksEnabled: (enabled) => setAgentMonitorHooksEnabled(enabled),
    isGoldenMode: () => deps.isGoldenMode(),
  });
  registerLogsActivityIpcHandlers(ipcMain, {
    getLogEntries: () => gatewayLog.getEntries(),
    clearLogs: () => gatewayLog.clear(),
    getLogFilePath: () => getMainLogFilePath(),
    openLogFile: () => openMainLogFile(),
    activityLog: deps.activityLog,
  });

  registerSettingsIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    settingsStore: deps.settingsStore,
    apiKeyStore: deps.apiKeyStore,
    pruneAlwaysAllowRules: (rules) => pruneExpiredAlwaysAllowRules(rules),
    isGoldenMode: () => deps.isGoldenMode(),
    cancelManagedOnboardingForUserChange: (reason) =>
      deps.managedOnboarding.cancelManagedOnboardingForUserChange(reason),
    getCloudCommandsPaused: () => deps.getCloudCommandsPaused(),
    setCloudCommandsPaused: (paused) => deps.setCloudCommandsPaused(paused),
    getCloudConnectionEnabled: () => deps.getCloudConnectionEnabled(),
    setCloudConnectionEnabled: (enabled) =>
      deps.setCloudConnectionEnabled(enabled),
    sendFlagsChanged: () => {
      // ISS-5037: a flag write from ANY path (settings IPC, env override
      // reconciliation) must be reflected by the "Enable Labs" application-menu
      // checkbox, or it would keep claiming a state the store disagrees with.
      refreshApplicationMenu();
      deps.desktopWindow.sendToRenderer("desktop:flags-changed");
    },
    restartCloudSocket: () => deps.restartCloudSocket(),
    // FEA-3741 (slice 1): a per-tool collector toggle change restarts the
    // collectors so the new enable snapshot takes effect immediately (a
    // toggled-off harness stops its watcher + tool-home walk; a re-enabled one
    // resumes). Mirrors the hooks-toggle collector restart.
    // The restart promise is deliberately not awaited here — the settings write
    // must not block on a collector restart (same fire-and-forget shape as the
    // hooks-toggle path); the runtime logs its own restart failures.
    restartCollectors: () => {
      deps.getAgentDashboardRuntime()?.restartCollectors();
    },
  });
  registerCommandSigningKeysIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    authorizedCommandKeys: deps.authorizedCommandKeys,
    listCommandSigningKeys: () =>
      deps.commandSigningController.listCommandSigningKeys(),
    notifyCommandKeysChanged: () =>
      deps.commandSigningController.notifyCommandKeysChanged(),
    approveOrganizationCommandPublicKey: (fingerprint) =>
      deps.commandSigningController.approveOrganizationCommandPublicKey(
        fingerprint
      ),
    rejectOrganizationCommandPublicKey: (fingerprint) =>
      deps.commandSigningController.rejectOrganizationCommandPublicKey(
        fingerprint
      ),
  });
  registerJobsIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    jobStore: deps.jobStore,
  });
  registerApprovalsIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    approvalStore: deps.approvalStore,
    settingsStore: deps.settingsStore,
    saveAlwaysAllowRuleForPending: (pending) =>
      deps.approvalEvaluator.saveAlwaysAllowRuleForPending(pending),
  });
  registerApiKeyIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    apiKeyStore: deps.apiKeyStore,
    costReconciliation: deps.costReconciliation,
    cancelManagedOnboardingForUserChange: (reason) =>
      deps.managedOnboarding.cancelManagedOnboardingForUserChange(reason),
    warmTelemetryOrgIdentity: () => deps.telemetryOrgProvider.warm(),
    restartCloudSocket: () => deps.restartCloudSocket(),
    onApiKeyChanged: () =>
      deps.desktopSessionManager.refreshExistingUserResolution(),
    // PRD-532 §5.5 (PR-K / M8): retire the manual paste path in the
    // unified-auth flow (relay key is auto-provisioned, DESKTOP_MANAGED).
    // Only disable manual entry once a DESKTOP_MANAGED key is actually held:
    // auto-provisioning treats failure/pop_unavailable as non-fatal (see
    // maybeAutoProvisionManagedKey), so if provisioning has not (yet) produced
    // a managed key, the paste path must stay available as the fallback —
    // otherwise a transient PoP/API failure locks a keyless install out of
    // ever configuring a relay key.
    isManualApiKeyEntryDisabled: () =>
      deps.apiKeyStore.getApiKeyProvenance() === "DESKTOP_MANAGED",
  });
  registerCostReconciliationIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    costReconciliation: deps.costReconciliation,
    claudeCodeAnalytics: deps.claudeCodeAnalytics,
  });
  registerCloudControlIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getCloudCommandsPaused: () => deps.getCloudCommandsPaused(),
    setCloudCommandsPaused: (paused) => deps.setCloudCommandsPaused(paused),
    getCloudConnectionEnabled: () => deps.getCloudConnectionEnabled(),
    setCloudConnectionEnabled: (enabled) =>
      deps.setCloudConnectionEnabled(enabled),
  });
  registerOnboardingIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    settingsStore: deps.settingsStore,
    apiKeyStore: deps.apiKeyStore,
    getSessionOrganizationId: () =>
      deps.desktopSessionManager.getIdentity()?.organizationId ?? null,
    getOnboardingState: () => deps.managedOnboarding.getOnboardingState(),
    cancelManagedOnboardingForUserChange: (reason) =>
      deps.managedOnboarding.cancelManagedOnboardingForUserChange(reason),
    persistActiveProfileKey: (apiKey, provenance) =>
      deps.persistActiveProfileKey(apiKey, provenance),
    warmTelemetryOrgIdentity: () => deps.telemetryOrgProvider.warm(),
    applyBinaryPathPatch: (patch) => deps.applyBinaryPathPatch(patch),
    restartCloudSocket: () => deps.restartCloudSocket(),
    startDeviceOnboarding: (webAppOrigin) =>
      deps.managedOnboarding.startDesktopFirstDeviceOnboarding(webAppOrigin),
    onSyncObservabilityTierChanged: () =>
      kickTranscriptSweepAfterTierChange(deps.getTranscriptSync()),
    applyDataSyncLevel: (level) => deps.applyDataSyncLevel(level),
  });
  registerBinaryPathsIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getBinaryPaths: () => deps.settingsStore.getBinaryPaths(),
    applyBinaryPathPatch: (patch) => deps.applyBinaryPathPatch(patch),
  });
  registerSandboxIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
  });
  registerDebugIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getDangerousAutoApprove: () => deps.getDangerousAutoApprove(),
    setDangerousAutoApprove: (enabled) => {
      deps.setDangerousAutoApprove(enabled);
    },
    isDebugAuthEnabled: () => deps.isDebugAuthEnabled(),
    sessionStore: deps.sessionStore,
  });
  registerUpdateIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getPackagedUpdateState: () => deps.getPackagedUpdateState(),
    setPackagedUpdateState: (patch) => deps.setPackagedUpdateState(patch),
    getPackagedUpdateStatusPayload: () => deps.getPackagedUpdateStatusPayload(),
    guardUpdateDownload: (result) => deps.guardUpdateDownload(result),
    checkForUpdate: () => deps.checkForUpdate(),
    notifyPackagedUpdateStatus: () => deps.notifyPackagedUpdateStatus(),
    setApplyingDownloadedUpdate: (value) => {
      deps.setApplyingDownloadedUpdate(value);
    },
    applyUpdate: () => deps.applyUpdate(),
  });

  registerProfileConfigIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    settingsStore: deps.settingsStore,
    apiKeyStore: deps.apiKeyStore,
    getGatewaySnapshot: () => {
      const cloudStatus = deps.getCloudStatus();
      return {
        gatewayPort: deps.server.getActivePort() ?? null,
        computeTarget:
          cloudStatus.state === "online" ? cloudStatus.targetId : null,
      };
    },
    cancelManagedOnboardingForUserChange: (reason) =>
      deps.managedOnboarding.cancelManagedOnboardingForUserChange(reason),
    onActiveConfigDeleted: () => onActiveConfigDeleted(deps),
    onConfigDeleted: (config) => onConfigDeleted(deps, config),
    restartCloudSocket: () => deps.restartCloudSocket(),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    seedReposConfig: (sandboxBaseDirectory) =>
      seedReposConfig(sandboxBaseDirectory),
  });

  registerDesktopAuthIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    manager: deps.desktopSessionManager,
  });
  // Existing-user resolution (PRD-532 §8 / M6): read the derived one-time
  // prompt state + record dismissal. Only non-secret advisory UI state crosses
  // here — no token, refresh token, or API key.
  registerDesktopExistingUserIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    manager: deps.desktopSessionManager,
  });
  // Cloud-API fetch bridge (PLN-1138 D-G Option B): the renderer's shared
  // `ApiAdapter` reads the cloud REST API through this handler; the access
  // token and target origin are resolved here and never cross to the renderer.
  registerCloudApiFetchIpcHandler(ipcMain, {
    isTrustedSender: (sender) => deps.desktopWindow.isTrustedSender(sender),
    getAccessToken: () => deps.desktopSessionManager.getAccessToken(),
    getIdentity: () => deps.desktopSessionManager.getIdentity(),
    resolveApiOrigin: () =>
      normalizeAndValidateOrigin(deps.settingsStore.getApiOrigin()),
  });
  registerDesktopTranscriptIpcHandlers(deps);
  registerGitHubConnectOpenerIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getWebAppOrigin: () => deps.settingsStore.getWebAppOrigin(),
    openExternal: (url) => shell.openExternal(url),
  });
  registerSessionLimitsIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    isGoldenMode: () => deps.isGoldenMode(),
  });
  registerDesktopIdentityIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getAccessToken: () => deps.desktopSessionManager.getAccessToken(),
    getApiOrigin: () => deps.settingsStore.getApiOrigin(),
  });

  registerManagedKeyHintIpcHandlers(ipcMain, {
    apiKeyStore: deps.apiKeyStore,
    settingsStore: deps.settingsStore,
  });
}

/**
 * Cloud-transcript read bridge (FEA-3324 Option B2) plus the FEA-3489
 * force-archive channel — the two transcript-reading renderer bridges.
 */
function registerDesktopTranscriptIpcHandlers(
  deps: DesktopIpcRegistrationDeps
): void {
  // The renderer asks main to prepare a transcript by (sessionId, fileKey);
  // main mints the signed S3 URL itself, streams the bytes into the userData
  // cache, and returns an `app://` URL. The (multi-MB) bytes never cross IPC and
  // `connect-src` stays 'self' app:.
  registerTranscriptReadIpcHandler(ipcMain, {
    isTrustedSender: (sender) => deps.desktopWindow.isTrustedSender(sender),
    getAccessToken: () => deps.desktopSessionManager.getAccessToken(),
    getIdentity: () => deps.desktopSessionManager.getIdentity(),
    resolveApiOrigin: () =>
      normalizeAndValidateOrigin(deps.settingsStore.getApiOrigin()),
    cacheDir: resolveTranscriptCacheDir(app.getPath("userData")),
    // Graceful LOCAL fallback: when the cloud (S3) read fails or the file is
    // not cloud-readable, serve the on-disk `.jsonl` for this (sessionId,
    // fileKey). The candidate path is resolved store-first (fast) but falls
    // back to a fresh collector-root discovery, so it works even when the
    // transcript-sync flag is OFF or the file has not yet been observed/synced
    // — a user whose bytes simply haven't uploaded still sees their local
    // copy. The path is derived from trusted collector roots (never the
    // renderer) and re-anchored to the transcript root via the SAME resolver
    // the sync service uses before a byte is read.
    // The bridge passes the HARNESS `externalSessionId` here (not the cloud
    // `sessionId`) so the store/discovery lookup, which indexes by on-disk
    // identity, actually matches — otherwise the fallback silently no-ops.
    getLocalTranscriptPath: (externalSessionId, fileKey) =>
      resolveLocalTranscriptPath(
        // Shared factory wires the lazy discovery import once (keeping the
        // collector modules off the desktop-boot static-import graph — the
        // agent-dashboard boundary — matching the sync service's own import).
        createLocalTranscriptResolverDeps(
          () => deps.getAgentDashboardRuntime()?.transcriptSync ?? null,
          // FEA-3932: bind the materialized-OpenCode enumerator so the local
          // read fallback resolves OpenCode projections too (not just
          // Claude/Codex). Without the state dir the default no-op enumerator
          // leaves OpenCode transcripts with no local fallback.
          deps.transcriptStateDir()
        ),
        externalSessionId,
        fileKey
      ),
    resolveTrustedTranscriptPath: (candidate) =>
      resolveTrustedClaudeTranscriptPath(candidate),
  });
  // FEA-3489 (PRD-536): user-initiated force-archive of ONE oversized transcript
  // the automatic lane dead-lettered for exceeding the size cap. The closure
  // re-reads the transcript lane at call time so it binds to the live service
  // even after a FEA-3907 privacy-tier rebuild; a null service (lane disabled)
  // yields an `unavailable` result rather than a hard failure.
  registerTranscriptForceArchiveIpcHandler(ipcMain, {
    isTrustedSender: (sender) =>
      deps.desktopWindow.isTrustedSender(sender as WebContents),
    forceSyncOversized: (externalSessionId, fileKey) =>
      deps
        .getTranscriptSync()
        ?.forceSyncOversized(externalSessionId, fileKey) ??
      Promise.resolve({ kind: "unavailable" as const }),
  });
}

/**
 * The active saved profile was deleted: cancel any managed onboarding, reset the
 * origins to their defaults, drop the browser command-key profile state, tear
 * down the cloud link, clear the key, and re-derive the dependent state.
 */
function onActiveConfigDeleted(deps: DesktopIpcRegistrationDeps): void {
  deps.managedOnboarding.cancelManagedOnboardingForUserChange(
    "the active saved config was deleted"
  );
  deps.settingsStore.setRelayOrigin(DEFAULT_DESKTOP_SETTINGS.relayOrigin);
  deps.settingsStore.setApiOrigin(DEFAULT_DESKTOP_SETTINGS.apiOrigin);
  deps.settingsStore.setWebAppOrigin(DEFAULT_DESKTOP_SETTINGS.webAppOrigin);
  resetBrowserCommandKeyProfileState({
    lifecycle: deps.commandKeyLifecycle,
    stopReconciliation: () => deps.commandKeyReconciler.stop(),
    reason: "active_config_deleted",
  });
  deps.cloudSocketStartup.invalidate();
  deps.cloudSocket.stop();
  deps.apiKeyStore.clearApiKey();
  deps.restartCloudSocket();
  // Key cleared → re-derive the existing-user sync-prompt resolution
  // (PRD-532 §8 / M6) so it doesn't stay stale after config deletion.
  deps.desktopSessionManager.refreshExistingUserResolution();
  deps.telemetryOrgProvider.warm();
  deps.refreshTrayState();
}

/** Drop a deleted profile's signing key once no remaining config references it. */
function onConfigDeleted(
  deps: DesktopIpcRegistrationDeps,
  config: Pick<SavedConfig, "gatewayId"> | undefined
): void {
  if (!config?.gatewayId) {
    return;
  }
  const activeRuntimeGatewayId = deps.settingsStore.getActiveConfigId()
    ? null
    : deps.legacyGatewayId;
  if (
    !deps.settingsStore.isGatewayIdReferenced(config.gatewayId, {
      activeRuntimeGatewayId,
    })
  ) {
    deps.gatewaySigningKeyStore.delete(config.gatewayId);
  }
}

/**
 * Register every main-process IPC handler the desktop app owns. Called once from
 * the application constructor.
 *
 * ISS-4430: when profiling is on, `ipcMain.handle` is patched with a wall-time
 * wrapper for the DURATION of the registration block below, so every channel
 * registered there is measured without a per-registrar edit. `withIpcProfiling`
 * owns restoring it — including when a registrar throws, which must not leave
 * the patch installed for the rest of the process lifetime. When profiling is
 * off — the production default — `getIpcProfilingSink()` returns `null` and this
 * is a plain call to {@link registerAllDesktopIpcHandlers}.
 */
export function registerDesktopIpcHandlers(
  deps: DesktopIpcRegistrationDeps
): void {
  const profilingSink = getIpcProfilingSink();
  if (!profilingSink) {
    registerAllDesktopIpcHandlers(deps);
    return;
  }
  withIpcProfiling(ipcMain, profilingSink, () =>
    registerAllDesktopIpcHandlers(deps)
  );
}
