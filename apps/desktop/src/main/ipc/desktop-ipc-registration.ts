import {
  OnboardingEvent,
  OnboardingStep,
} from "@closedloop-ai/telemetry-contract/app";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { app, ipcMain, safeStorage, shell, type WebContents } from "electron";
import pkg from "electron-updater";
import type { DesktopGatewayServer } from "../../server/server.js";
import type { AgentMonitorRuntimeStatus } from "../../shared/agent-monitor-status.js";
import type { CoachingPackInfo } from "../../shared/coaching-pack-contract.js";
import type { ConnectionSecurityStatus } from "../../shared/connection-security.js";
import {
  DEFAULT_DESKTOP_SETTINGS,
  type SavedConfig,
} from "../../shared/contracts.js";
import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import { GATEWAY_DISPATCH_CHANNEL } from "../../shared/gateway-dispatch-channel.js";
import type { LocalSessionSourceStatus } from "../../shared/local-session-source-status.js";
import { RENDERER_OTEL_EXPORT_CHANNEL } from "../../shared/renderer-otel-bridge-constants.js";
import {
  isAgentMonitorHooksEnabled,
  setAgentMonitorHooksEnabled,
} from "../agent-monitor/agent-monitor-hooks.js";
import type { AgentSessionSyncService } from "../agent-sync/agent-session-sync-service.js";
import type { ComputeTargetLinkBlockState } from "../agent-sync/compute-target-link-block.js";
import { pruneExpiredAlwaysAllowRules } from "../approvals/always-allow-rules.js";
import type { ApprovalEvaluator } from "../approvals/approval-evaluator.js";
import type { ApprovalStore } from "../approvals/approval-store.js";
import {
  readDesktopMainCheckedFeatureFlags,
  setDesktopMainFeatureFlagOverrides,
} from "../auth/desktop-feature-flag-dev-mode.js";
import type { LocalSessionStore } from "../auth/local-session-store.js";
import {
  type CloudSocketStatus,
  resolveOnlineComputeTargetId,
} from "../cloud/cloud-protocol.js";
import type { CloudSocketService } from "../cloud/cloud-socket.js";
import type { CloudSocketStartupCoordinator } from "../cloud/cloud-socket-startup.js";
import type { GatewaySigningKeyStore } from "../command-signing/gateway-signing-key-store.js";
import type { ClaudeCodeAnalyticsService } from "../cost/claude-code-analytics-service.js";
import type { CostReconciliationService } from "../cost/cost-reconciliation-service.js";
import type { AgentDashboardDesignSystemRuntime } from "../dashboard/agent-dashboard-design-system-runtime.js";
import type { ActivityLogStore } from "../diagnostics/activity-log-store.js";
import type { DocsHelpService } from "../docs-help/docs-bundle.js";
import { createGitHubConnectReturnWatch } from "../github/github-connect-return-watch.js";
import type { GatewayRecoveryManager } from "../lifecycle/gateway-recovery.js";
import type { RendererReadinessGates } from "../lifecycle/renderer-readiness-gates.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  getMainLogFilePath,
  openMainLogFile,
} from "../logging/persistent-log.js";
import { resolveDesktopMachineName } from "../machine-name.js";
import type { ManagedOnboardingController } from "../onboarding/managed-onboarding-controller.js";
import { createOnboardingLocalStateSource } from "../onboarding/onboarding-local-state-source.js";
import { registerPackAnalyticsIpc } from "../packs/pack-analytics-ipc.js";
import type { RequiredPluginInstaller } from "../packs/required-plugin-installer.js";
import { withIpcProfiling } from "../profiling/ipc-profiling.js";
import {
  getIpcProfilingSink,
  getRenderCommitProfilingSink,
} from "../profiling/main-profiling-session.js";
import type { DesktopRealtimeHost } from "../realtime/desktop-realtime-host.js";
import type { DesktopSessionManager } from "../session/desktop-session-manager.js";
import { registerSessionLimitsIpcHandlers } from "../session-limits-ipc.js";
import type { ApiKeyStore } from "../settings/api-key-store.js";
import { normalizeAndValidateOrigin } from "../settings/origin-policy.js";
import { seedReposConfig } from "../settings/seed-repos-config.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { SyncBurndownReporter } from "../sync/sync-burndown-reporter.js";
import type { DesktopOtelRuntime } from "../telemetry/app-otel-runtime.js";
import { createDeadEndTelemetryRecorder } from "../telemetry/dead-end-telemetry-recorder.js";
import { Observability } from "../telemetry/observability.js";
import type { TelemetryOrgProvider } from "../telemetry/telemetry-org-identity.js";
import { resolveTranscriptCacheDir } from "../transcript/transcript-read-cache.js";
import {
  createLocalTranscriptResolverDeps,
  resolveLocalTranscriptPath,
} from "../transcript-sync/local-transcript-path-resolver.js";
import { kickTranscriptSweepAfterTierChange } from "../transcript-sync/transcript-sweep-kick.js";
import { transcriptSyncLaneAbsentStatus } from "../transcript-sync/transcript-sync-lane-absent-status.js";
import type { TranscriptSyncService } from "../transcript-sync/transcript-sync-service.js";
import { resolveTrustedClaudeTranscriptPath } from "../transcript-sync/trusted-transcript-path.js";
import { checkForStampedUpdates } from "../update/auto-update-wiring.js";
import type {
  PackagedUpdateState,
  PackagedUpdateStatusPayload,
} from "../update/packaged-update-state.js";
import type { DesktopUpdateLifecycleReporter } from "../update/update-lifecycle-telemetry.js";
import { desktopInstallationId } from "../util/desktop-client-attribution-provider.js";
import type { DesktopWindow } from "../window.js";
import {
  buildAgentDashboardRuntimeProgressGetters,
  buildOnboardingParseProgressReader,
  buildTranscriptForceSyncOversized,
} from "./agent-dashboard-runtime-degradations.js";
import { registerAgentMonitorIpcHandlers } from "./agent-monitor-ipc.js";
import { registerApiKeyIpcHandlers } from "./api-key-ipc.js";
import { registerApprovalsIpcHandlers } from "./approvals-ipc.js";
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
import { registerCostReconciliationIpcHandlers } from "./cost-reconciliation-ipc.js";
import { registerDeadEndTelemetryIpcHandlers } from "./dead-end-telemetry-ipc.js";
import { registerDebugIpcHandlers } from "./debug-ipc.js";
import { registerDesktopAuthIpcHandlers } from "./desktop-auth-ipc.js";
import { registerDesktopDevModeIpcHandlers } from "./desktop-dev-mode-ipc.js";
import { registerDesktopExistingUserIpcHandlers } from "./desktop-existing-user-ipc.js";
import {
  accountGitHubConnectionReads,
  type DesktopIdentityIpcDeps,
  registerDesktopIdentityIpcHandlers,
} from "./desktop-identity-ipc.js";
import { registerDesktopRealtimeIpcHandlers } from "./desktop-realtime-ipc.js";
import { registerDirectoryScopeIpcHandlers } from "./directory-scope-ipc.js";
import { registerDocsHelpIpcHandlers } from "./docs-help-ipc.js";
import { registerE2eFeatureFlagSeedIpcHandler } from "./e2e-feature-flag-seed-ipc.js";
import { createGatewayDispatchHandler } from "./gateway-dispatch-ipc.js";
import { registerGitHubConnectOpenerIpcHandlers } from "./github-connect-opener-ipc.js";
import { registerLogsActivityIpcHandlers } from "./logs-activity-ipc.js";
import { registerManagedKeyHintIpcHandlers } from "./managed-key-hint-ipc.js";
import { registerMoveToApplicationsIpcHandler } from "./move-to-applications-ipc.js";
import { registerOnboardingIpcHandlers } from "./onboarding-ipc.js";
import { registerOnboardingLocalStateIpcHandlers } from "./onboarding-local-state-ipc.js";
import { registerProfileConfigIpcHandlers } from "./profile-config-ipc.js";
import { sendToRendererWindow } from "./renderer-ipc.js";
import { registerRendererLifecycleIpcHandlers } from "./renderer-lifecycle-ipc.js";
import { createRendererOtelExportHandler } from "./renderer-otel-ipc.js";
import { registerRuntimeInfoIpcHandlers } from "./runtime-info-ipc.js";
import { registerSandboxIpcHandlers } from "./sandbox-ipc.js";
import { registerSettingsIpcHandlers } from "./settings-ipc.js";
import { registerSettingsLocalDeviceIpcHandlers } from "./settings-local-device-ipc.js";
import { registerSurfaceAnalyticsIpcHandlers } from "./surface-analytics-ipc.js";
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
  claudeCodeAnalytics: ClaudeCodeAnalyticsService;
  cloudSocket: CloudSocketService;
  cloudSocketStartup: CloudSocketStartupCoordinator;
  costReconciliation: CostReconciliationService;
  desktopSessionManager: DesktopSessionManager;
  signOutDesktop: () => Promise<void>;
  desktopWindow: DesktopWindow;
  docsHelp: DocsHelpService;
  gatewaySigningKeyStore: GatewaySigningKeyStore;
  /** Read per call: sign-out rotates it (ISS-11843). */
  getLegacyGatewayId: () => string;
  managedOnboarding: ManagedOnboardingController;
  recovery: GatewayRecoveryManager;
  realtimeHost: DesktopRealtimeHost;
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
  /** ISS-11426: the compute-target link block, or null when nothing is blocked. */
  getComputeTargetLinkBlock: () => ComputeTargetLinkBlockState | null;
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
  getCloudCommandsPaused: () => boolean;
  getCloudConnectionEnabled: () => boolean;
  getCloudStatus: () => CloudSocketStatus;
  getConnectionSecurityStatus: () => ConnectionSecurityStatus;
  getDangerousAutoApprove: () => boolean;
  getGatewayAuthToken: () => string;
  getLocalSessionSourceStatus: () => LocalSessionSourceStatus;
  getPackagedUpdateState: () => PackagedUpdateState;
  getPackagedUpdateStatusPayload: () => PackagedUpdateStatusPayload;
  getCloudReadComputeTargetId: () => string | null;
  /**
   * ISS-7516: this machine's cloud identity for transcript purposes, read
   * independently of whether a transcript-sync lane exists. Deliberately the
   * same accessor the live lane's `getComputeTargetId` is wired with, so the
   * `computeTargetId` a renderer compares against is one value with one rule
   * rather than two that can disagree by tier.
   */
  getTranscriptComputeTargetId: () => string | null;
  getTranscriptSync: () => TranscriptSyncService | null;
  /**
   * ISS-9164: the ring identity the renderer's "Check for updates" stamps. Its
   * own accessor rather than a reuse of the transcript one above: the updater
   * feed is unauthenticated, so it takes the auth-gated target the scheduled
   * poll uses, not the strict-online one (marisolashgrove, #6867).
   */
  getUpdaterComputeTargetId: () => string | null;
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
  /** ISS-10890: the Welcome Start agreement was recorded; release the gate. */
  onSessionAnalysisAgreed: () => void;
  /**
   * ISS-10950: a live collector restart, refused while the onboarding analysis
   * gate is still held. `undefined` when nothing ran — no runtime yet, or the
   * gate refused it.
   */
  restartCollectors: () => Promise<void> | undefined;
  setApplyingDownloadedUpdate: (value: boolean) => void;
  setCloudCommandsPaused: (paused: boolean) => void;
  setCloudConnectionEnabled: (enabled: boolean) => void;
  setDangerousAutoApprove: (enabled: boolean) => void;
  setPackagedUpdateState: (patch: Partial<PackagedUpdateState>) => void;
  transcriptStateDir: () => string;
  /** ISS-7247 release-health reporter; see `DesktopUpdateWiringDeps`. */
  updateTelemetry: DesktopUpdateLifecycleReporter;
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
  // ISS-7249: one recorder per registration so the per-process emission cap is
  // shared by every dead-end record rather than reset per call.
  const deadEndTelemetryRecorder = createDeadEndTelemetryRecorder({
    emit: (input) => deps.appOtelRuntime.emitDeadEndEvent(input),
  });
  // ISS-8376: ONE source per registration, because it owns the at-most-once
  // sweep. A source per call would re-sweep on every read — the 638 ms / 4 s
  // cost this design exists to pay exactly once.
  const onboardingLocalStateSource = createOnboardingLocalStateSource({
    transcriptStateDir: () => deps.transcriptStateDir(),
    getComputeTargetId: () => deps.getTranscriptComputeTargetId(),
    // Routed to the onboarding lifecycle record rather than a new one: this is
    // the setup step failing to measure, and it rides the same pre-auth relay.
    // Uncapped because the sweep is one-shot per source and its runner reports
    // only the reply that settles it, so this fires at most once per
    // registration.
    onMalformedSweepReply: () =>
      deps.appOtelRuntime.emitOnboardingEvent({
        step: OnboardingStep.Setup,
        event: OnboardingEvent.Failed,
      }),
    // ISS-8346: the boot import IS the parse lane the estimate measures. Keep
    // this a `(deps.getAgentDashboardRuntime)` call — the binding, including the
    // per-call re-read that lets it follow a runtime built AFTER registration,
    // lives where a node test can execute it.
    readParseProgress: buildOnboardingParseProgressReader(
      deps.getAgentDashboardRuntime
    ),
  });
  registerDeadEndTelemetryIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    recordDeadEndTelemetry: (payload) =>
      deadEndTelemetryRecorder.record(payload),
  });

  registerRendererLifecycleIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => deps.desktopWindow.isTrustedSender(sender),
    handleRendererReady: (sender, phase) =>
      deps.desktopWindow.handleRendererReady(sender, phase),
    yieldToMainLoop: () => deps.yieldToMainLoop(),
    sendToRenderer: (channel, ...args) =>
      sendToRendererWindow(deps.desktopWindow.getWindow(), channel, ...args),
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
    // ISS-8776: reports WHY a refusal happened; never whether one happens.
    isRendererWindowGone: () => deps.desktopWindow.isRendererWindowGone(),
    getAppVersion: () => app.getVersion(),
    getIsPackaged: () => app.isPackaged,
    settingsStore: deps.settingsStore,
    // ISS-7516: a machine with no lane is an ordinary state, not an edge — any
    // data-sync level below Full persists `transcriptSyncEnabled` false, so
    // `getTranscriptSync()` is null for every such machine. ISS-10554 moved the
    // new-install default UP to Full, so this is now the state of a user who
    // picked a lower level rather than of the shipped default. The no-lane
    // snapshot lives in its own module so that branch is executable by a node test.
    getTranscriptSyncStatus: async () =>
      (await deps.getTranscriptSync()?.getStatusSnapshot()) ??
      transcriptSyncLaneAbsentStatus(deps.getTranscriptComputeTargetId()),
    getActivePort: () => deps.server.getActivePort(),
    getCloudStatus: () => deps.getCloudStatus(),
    getCloudCommandsPaused: () => deps.getCloudCommandsPaused(),
    getCloudConnectionEnabled: () => deps.getCloudConnectionEnabled(),
    getConnectionSecurityStatus: () => deps.getConnectionSecurityStatus(),
    isServerAlive: () => deps.server.isAlive(),
    getGatewayHealthy: () => deps.recovery.gatewayHealthy,
    // ISS-8143: keep this a call, not three closures — see the builder's own
    // file for why a literal here puts the binding out of every test's reach.
    ...buildAgentDashboardRuntimeProgressGetters(deps.getAgentDashboardRuntime),
    getCloudSyncProgress: () => deps.agentSessionSync.getSyncProgress(),
    getComputeTargetLinkBlock: () => deps.getComputeTargetLinkBlock(),
    getDashboardReady: () =>
      deps.rendererGates.isInitialCollectorImportComplete(),
    getAgentMonitorStatus: () => deps.getAgentMonitorRuntimeStatus(),
    getNodeUuid: desktopInstallationId,
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
  // ISS-8379 (PRD-691): the Settings local-device read. Facts main already
  // holds — no local operation, no cloud record. The cloud `ComputeTarget` row
  // this id names is still read through the authorized cloud API.
  registerSettingsLocalDeviceIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getMachineName: () => resolveDesktopMachineName(),
    getPlatform: () => process.platform,
    getAppVersion: () => app.getVersion(),
    getActivePort: () => deps.server.getActivePort(),
    isServerAlive: () => deps.server.isAlive(),
    getComputeTargetId: () =>
      resolveOnlineComputeTargetId(deps.getCloudStatus()),
  });
  registerCoachingIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    isAgentCoachingTipsEnabled: () => deps.isAgentCoachingTipsEnabled(),
    isCoachingPacksEnabled: () => deps.isCoachingPacksEnabled(),
    getActiveCoachingPackSeeded: () => deps.getActiveCoachingPackSeeded(),
    coachingPacksDir: () => deps.coachingPacksDir(),
    getCloudReadComputeTargetId: () => deps.getCloudReadComputeTargetId(),
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
    acknowledgeOptInHandled: (computeTargetId, distributionId) =>
      deps.requiredPluginInstaller.acknowledgeOptInHandled(
        computeTargetId,
        distributionId
      ),
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
    // when the runtime isn't up yet, or when the analysis consent gate refused
    // the restart — nothing ran, resolve immediately.
    restartCollectors: () => deps.restartCollectors(),
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
      deps.desktopWindow.sendToRenderer(
        DesktopRendererEventChannel.FlagsChanged
      );
    },
    restartCloudSocket: () => deps.restartCloudSocket(),
    // FEA-3741 (slice 1): a per-tool collector toggle change restarts the
    // collectors so the new enable snapshot takes effect immediately (a
    // toggled-off harness stops its watcher + tool-home walk; a re-enabled one
    // resumes). Mirrors the hooks-toggle collector restart.
    // The restart promise is deliberately not awaited here: the settings write
    // must not block on a collector restart (same fire-and-forget shape as the
    // hooks-toggle path). The runtime does NOT log its own restart failures, and
    // before this catch a rejection reached the unhandledRejection handler and
    // the crash dialog, so the failure is recorded here rather than dropped.
    restartCollectors: () => {
      deps.restartCollectors()?.catch((error: unknown) => {
        gatewayLog.warn(
          "collectors",
          `restart after a collector toggle failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    },
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
    isCredentialMutationAllowed: () =>
      !deps.settingsStore.getSignOutCleanupState().isPending(),
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
    // ISS-5489: the renderer's consent snapshot is shared across the read-source
    // decision, the takeover gate and the arrival nudge, so a write has to reach
    // all of them and not only the surface that made it. `sendToRenderer` is the
    // crash-safe path (it already guards every window/frame teardown state).
    sendToRenderer: (channel, ...args) => {
      deps.desktopWindow.sendToRenderer(channel, ...args);
    },
    applyDataSyncLevel: (level) => deps.applyDataSyncLevel(level),
    onSessionAnalysisAgreed: () => deps.onSessionAnalysisAgreed(),
  });
  // ISS-8376: the desktop-local onboarding facts. The source owns the one-shot
  // off-thread sweep, so this registration hands it seams rather than data —
  // `read()` is synchronous and never waits on the sweep.
  registerOnboardingLocalStateIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    isRendererWindowGone: () => deps.desktopWindow.isRendererWindowGone(),
    source: onboardingLocalStateSource,
  });
  registerBinaryPathsIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getBinaryPaths: () => deps.settingsStore.getBinaryPaths(),
    applyBinaryPathPatch: (patch) => deps.applyBinaryPathPatch(patch),
  });
  registerSandboxIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
  });
  registerDirectoryScopeIpcHandlers(ipcMain, {
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
    checkForUpdates: () =>
      checkForStampedUpdates(() => deps.getUpdaterComputeTargetId()),
    guardUpdateDownload: (result) => deps.guardUpdateDownload(result),
    checkForUpdate: () => deps.checkForUpdate(),
    notifyPackagedUpdateStatus: () => deps.notifyPackagedUpdateStatus(),
    setApplyingDownloadedUpdate: (value) => {
      deps.setApplyingDownloadedUpdate(value);
    },
    applyUpdate: () => deps.applyUpdate(),
    updateTelemetry: deps.updateTelemetry,
  });

  registerProfileConfigIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    settingsStore: deps.settingsStore,
    apiKeyStore: deps.apiKeyStore,
    getGatewaySnapshot: () => ({
      gatewayPort: deps.server.getActivePort() ?? null,
      computeTarget: resolveOnlineComputeTargetId(deps.getCloudStatus()),
    }),
    cancelManagedOnboardingForUserChange: (reason) =>
      deps.managedOnboarding.cancelManagedOnboardingForUserChange(reason),
    onActiveConfigDeleted: () => onActiveConfigDeleted(deps),
    onConfigDeleted: (config) => onConfigDeleted(deps, config),
    restartCloudSocket: () => deps.restartCloudSocket(),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    seedReposConfig: (sandboxBaseDirectory) =>
      seedReposConfig(sandboxBaseDirectory),
  });

  registerSurfaceAnalyticsIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    captureAnalytics: (event, properties) =>
      Observability.rendererSurfaceAnalytics(event, properties),
  });

  registerDesktopAuthIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    manager: deps.desktopSessionManager,
    isSignInAllowed: () =>
      !deps.settingsStore.getSignOutCleanupState().isPending(),
    signOut: deps.signOutDesktop,
    // ISS-10412: the sign-in journey finishes in the browser, so the desktop
    // has to put itself back in front of the person who started it.
    bringWindowToFront: () => deps.desktopWindow.returnFromBrowserSignIn(),
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
    getAccountAdmission: () =>
      deps.settingsStore.getSignOutCleanupState().isPending()
        ? null
        : deps.desktopSessionManager.getAccountAdmission(),
    getIdentity: () => deps.desktopSessionManager.getIdentity(),
    resolveApiOrigin: () =>
      normalizeAndValidateOrigin(deps.settingsStore.getApiOrigin()),
    // ISS-9701: match the sync lanes — a server 401 drops
    // the cached access token so the renderer's retry mints a fresh one. Scoped
    // to the rejected token, so a 401 that arrives after another request already
    // refreshed cannot evict the newer credential and start a second refresh.
    onUnauthorized: (rejectedToken) =>
      deps.desktopSessionManager.invalidateAccessToken(rejectedToken),
  });
  registerDesktopRealtimeIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    host: deps.realtimeHost,
  });
  registerDesktopTranscriptIpcHandlers(deps);
  const accountReadDeps: DesktopIdentityIpcDeps = {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getAccessToken: () => deps.desktopSessionManager.getAccessToken(),
    getApiOrigin: () => deps.settingsStore.getApiOrigin(),
    getAccountAdmission: () =>
      deps.settingsStore.getSignOutCleanupState().isPending()
        ? null
        : deps.desktopSessionManager.getAccountAdmission(),
  };
  registerGitHubConnectOpenerIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    getWebAppOrigin: () => deps.settingsStore.getWebAppOrigin(),
    openExternal: (url) => shell.openExternal(url),
    returnWatch: createGitHubConnectReturnWatch({
      ...accountGitHubConnectionReads(accountReadDeps),
      bringWindowToFront: () => deps.desktopWindow.returnFromBrowserSignIn(),
    }),
  });
  registerSessionLimitsIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    isGoldenMode: () => deps.isGoldenMode(),
  });
  registerDesktopDevModeIpcHandlers(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    setOverrides: setDesktopMainFeatureFlagOverrides,
    readCheckedKeys: readDesktopMainCheckedFeatureFlags,
  });
  registerDesktopIdentityIpcHandlers(ipcMain, accountReadDeps);

  // ISS-8753: the Electron E2E flag-assignment seam. A constant `null` on every
  // shipped launch — see `lifecycle/e2e-feature-flag-assignment.ts` for the two
  // gates that make that true.
  registerE2eFeatureFlagSeedIpcHandler(ipcMain, {
    isTrustedSender: (sender) => isTrustedSender(sender as WebContents),
    isPackaged: () => app.isPackaged,
    getArgv: () => process.argv,
    getUserDataPath: () => app.getPath("userData"),
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
  // no transcript origin joins `connect-src`.
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
    // ISS-8143: same reason as the progress getters above.
    forceSyncOversized: buildTranscriptForceSyncOversized(
      deps.getTranscriptSync
    ),
  });
}

/**
 * The active saved profile was deleted: cancel any managed onboarding, reset the
 * origins to their defaults, tear down the cloud link, clear the key, and
 * re-derive the dependent state.
 */
function onActiveConfigDeleted(deps: DesktopIpcRegistrationDeps): void {
  deps.managedOnboarding.cancelManagedOnboardingForUserChange(
    "the active saved config was deleted"
  );
  deps.settingsStore.setRelayOrigin(DEFAULT_DESKTOP_SETTINGS.relayOrigin);
  deps.settingsStore.setApiOrigin(DEFAULT_DESKTOP_SETTINGS.apiOrigin);
  deps.settingsStore.setWebAppOrigin(DEFAULT_DESKTOP_SETTINGS.webAppOrigin);
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
    : deps.getLegacyGatewayId();
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
