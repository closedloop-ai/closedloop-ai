/**
 * @file desktop-services.ts
 * @description Composition root for the desktop main process (PLN-1359 Phase 2).
 *
 * `DesktopApplication`'s constructor used to hand-wire every collaborator inline,
 * which made the class impossible to unit test: you could not construct it
 * without also constructing the real stores, gateway server, and cloud socket.
 * This module owns that wiring instead, so the constructor merely *accepts*
 * already-wired services (`new DesktopApplication(options, fakeServices)`).
 *
 * Why a `host` seam: the collaborators are wired with callbacks that reach back
 * into `DesktopApplication` (`telemetrySend: (event) => host.sendDesktopTelemetry(event)`),
 * and some close over services created *later* in the sequence. Those callbacks
 * are lazy — they only run after construction completes — which is exactly what
 * the original inline `() => this.x` arrows relied on. `DesktopServicesHost` makes
 * that previously-implicit coupling explicit and typed: it is the precise set of
 * things the wiring needs back from the application.
 *
 * Construction order here mostly matches the original constructor — several
 * collaborators read from stores built immediately before them, and the
 * telemetry bridge must bind the OTel runtime before anything emits — with two
 * behavior-neutral exceptions noted inline below: (1) tray/window/stores are
 * built before the session-manager subscriptions, and (2) cost reconciliation +
 * Claude Code analytics build at the tail of this factory, ahead of the deferred
 * gateway/cloud/recovery/transcript cluster that still constructs inline in
 * app.ts (originally they built after that cluster, before recovery). Both are
 * pure field assignment with no dependency on anything the deferred cluster
 * creates.
 */
import {
  app,
  ipcMain,
  Notification,
  session,
  shell,
  type WebContents,
} from "electron";
import type { AgentMonitorRuntimeStatusKind } from "../../shared/agent-monitor-status.js";
import {
  BUILD_APP_VERSION,
  BUILD_COMMIT_HASH,
} from "../../shared/build-info.js";
import type { DesktopAuthState } from "../../shared/contracts.js";
import { DesktopAuthStatus } from "../../shared/contracts.js";
import { DesktopDevModeIpcChannel } from "../../shared/desktop-dev-mode-channel.js";
import {
  DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY,
  DESKTOP_THREAD_VIEWERSHIP_SIGNAL_FEATURE_FLAG_KEY,
} from "../../shared/feature-flags-labs-detail.js";
import { installApplicationMenu } from "../app-menu.js";
import { ApprovalStore } from "../approvals/approval-store.js";
import { createFeatureFlagAccountBoundary } from "../auth/desktop-feature-flag-account-boundary.js";
import {
  createDesktopMainFeatureFlagAssignmentStore,
  publishDesktopMainFeatureFlagAssignmentStore,
} from "../auth/desktop-feature-flag-assignment.js";
import {
  createDesktopMainDevMode,
  publishDesktopMainDevMode,
} from "../auth/desktop-feature-flag-dev-mode.js";
import {
  fetchDesktopFeatureFlags,
  publishAnonymousDesktopFeatureFlagsSource,
} from "../auth/desktop-feature-flags-client.js";
import { fetchDesktopIdentity } from "../auth/desktop-identity-client.js";
import type {
  DesktopPopHeaders,
  DesktopPopSigningRequest,
} from "../auth/desktop-pop.js";
import {
  createDesktopReplayRecordingFence,
  installDesktopReplayRequestAuth,
} from "../auth/desktop-replay-request-auth.js";
import { LocalSessionStore } from "../auth/local-session-store.js";
import {
  createAuthFailureTelemetry,
  type DesktopAuthFailureEventInput,
} from "../cloud/auth-failure-telemetry.js";
import { GatewaySigningKeyStore } from "../command-signing/gateway-signing-key-store.js";
import {
  createAnthropicAdminKeyStore,
  createOpenAiAdminKeyStore,
} from "../cost/admin-key-store.js";
import { ClaudeCodeAnalyticsService } from "../cost/claude-code-analytics-service.js";
import { CostReconciliationService } from "../cost/cost-reconciliation-service.js";
import { ReconciliationStore } from "../cost/reconciliation-store.js";
import type { MeteredUsageRow } from "../cost/reconciliation-worker.js";
import { ActivityLogStore } from "../diagnostics/activity-log-store.js";
import { DESKTOP_EXISTING_USER_RESOLUTION_CHANGED_CHANNEL } from "../ipc/desktop-existing-user-ipc.js";
import { registerDesktopReplayRecordingIpcHandler } from "../ipc/desktop-replay-recording-ipc.js";
import type { RendererReadinessGates } from "../lifecycle/renderer-readiness-gates.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { startDesktopParsePolicyController } from "../parse-policy/parse-policy-resolver.js";
import { DesktopRealtimeHost } from "../realtime/desktop-realtime-host.js";
import { fetchDesktopRealtimeToken } from "../realtime/desktop-realtime-token.js";
import type { DesktopAccountAdmission } from "../session/desktop-account-admission.js";
import { DesktopSessionManager } from "../session/desktop-session-manager.js";
import type { DesktopDeviceDescriptor } from "../session/desktop-session-manager-types.js";
import { DesktopSessionStore } from "../session/desktop-session-store.js";
import type { DesktopSignInAnalytics } from "../session/desktop-sign-in-analytics.js";
import { setLocalSessionAuthoredPrGateResolver } from "../session/local-session-pr-gate.js";
import { setThreadViewershipSignalResolver } from "../session/thread-viewership-gate.js";
import { ApiKeyStore } from "../settings/api-key-store.js";
import type { GoldenModeConfig } from "../settings/golden-mode.js";
import {
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "../settings/origin-policy.js";
import { SettingsStore } from "../settings/settings-store.js";
import { createApiOtlpTelemetryTransport } from "../telemetry/api-otlp-telemetry-transport.js";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../telemetry/app-otel-runtime.js";
import {
  createDesktopAppLifecycleTelemetry,
  type DesktopAppLifecycleTelemetry,
  type DesktopAppOperatingMode,
} from "../telemetry/app-otel-runtime-lifecycle.js";
import { resolveDesktopTelemetryEgressEnabled } from "../telemetry/desktop-telemetry-egress.js";
import { genAiRequestTelemetry } from "../telemetry/gen-ai-request-telemetry.js";
import {
  Observability,
  type ObservabilityOptions,
  type ProductAnalyticsTransport,
} from "../telemetry/observability.js";
import { onboardingDiscardTelemetry } from "../telemetry/onboarding-discard-telemetry.js";
import { processExceptionTelemetryBridge } from "../telemetry/process-exception-telemetry-bridge.js";
import {
  createRelayTelemetryTransport,
  totalDroppedExports,
} from "../telemetry/relay-telemetry-transport.js";
import {
  createTelemetryOrgProvider,
  type TelemetryOrgProvider,
} from "../telemetry/telemetry-org-identity.js";
import {
  purgeTranscriptCache,
  resolveTranscriptCacheDir,
} from "../transcript/transcript-read-cache.js";
import { DesktopTray } from "../tray.js";
import { resolveDesktopBuildCommit } from "../util/desktop-build-commit.js";
import { setDesktopClientAttributionResolver } from "../util/desktop-client-attribution-provider.js";
import { resolveDesktopServiceVersion } from "../util/desktop-service-version.js";
import { NodeUuidStore } from "../util/node-uuid-store.js";
import { DesktopWindow } from "../window.js";

/**
 * Launch options for the desktop application. Lives here (rather than in
 * `app.ts`) so the composition root can type its own input without importing the
 * application module it is imported by.
 */
export type DesktopApplicationOptions = {
  /** Golden launch-mode config (FEA-2648); null/absent for a normal launch. */
  golden?: GoldenModeConfig | null;
};

/**
 * What the wired collaborators need back from `DesktopApplication`.
 *
 * Every member is invoked lazily (after construction), which is what lets the
 * wiring reference application methods — and services created later in the
 * sequence — exactly as the original inline `() => this.x` closures did.
 */
export type DesktopServicesHost = {
  beginSignInAnalytics: () => DesktopSignInAnalytics | null;
  /** Re-publish authoritative event-only renderer state after recreation. */
  onRendererNavigationReady: () => void;
  /**
   * FEA-3425 (Phase 3): Observability's transports route through the host so
   * the application can select per event between the authenticated HTTP twins
   * and the legacy relay socket. The referenced collaborators are created
   * later in the construction sequence, so each call resolves them lazily —
   * matching the original `this.cloudSocket?.` optional access during
   * construction.
   */
  sendProductAnalytics: ProductAnalyticsTransport["send"];
  flushProductAnalytics: ProductAnalyticsTransport["flush"];
  sendDesktopTelemetry: ObservabilityOptions["telemetrySend"];
  /**
   * FEA-3425 (Phase 3): bounded shutdown drain of the HTTP telemetry lane's
   * in-flight sends. The socket telemetry path is a synchronous emit with
   * nothing to drain; the HTTP twin awaits a token lookup + POST, so it needs
   * an explicit flush before the process exits.
   */
  flushDesktopTelemetry: (options: { timeoutMs: number }) => Promise<void>;
  getActiveGatewayId: () => string;
  getNodeUuidForTelemetry: () => string;
  getAppOperatingModeForTelemetry: () => DesktopAppOperatingMode;
  /** ISS-9082: the live Agent Monitor capture-runtime verdict for the heartbeat. */
  getAgentMonitorRuntimeStatusKindForTelemetry: () => AgentMonitorRuntimeStatusKind;
  /** PoP-sign an outbound desktop request (used by the session manager). */
  signDesktopRequest: (
    request: DesktopPopSigningRequest
  ) => DesktopPopHeaders | null;
  /** Resolve this device's descriptor for the browser sign-in flow. */
  resolveDesktopDeviceDescriptor: () => DesktopDeviceDescriptor;
  /** Push the latest desktop auth state to the renderer. */
  publishDesktopAuthState: (state: DesktopAuthState) => void;
  getDesktopAccountAdmission: () => DesktopAccountAdmission | null;
  onDesktopAccountChanged: (admission: DesktopAccountAdmission | null) => void;
  /**
   * Auto-provision the DESKTOP_MANAGED relay key after unified-auth sign-in
   * (PRD-532 §5.5 / M8). Fire-and-forget and single-flight; failures
   * fall back to the manual paste path.
   */
  maybeAutoProvisionManagedKey: () => Promise<void>;
  /**
   * Load the Agent Dashboard metered-usage rows the nightly cost reconciliation
   * compares against vendor-billed cost. Returns no rows when the dashboard is
   * disabled, so the reconciliation path stays inert.
   */
  loadAgentDashboardMeteredUsageRows: () => Promise<MeteredUsageRow[]>;
  /**
   * ISS-5346: the boot readiness gates, so the initial window reveal can wait
   * on `waitForInitialWindowRevealReadiness()` — a bounded wait that fails open,
   * so the window is never held invisible indefinitely.
   *
   * Passed as the gates object rather than a narrow thunk, matching how the
   * agent-dashboard runtime bootstrap already consumes them, and because
   * `app.ts` is on the shrink-only `noExcessiveLinesPerFile` grandfather list:
   * the explanation lives here, in the file that owns the wiring.
   */
  rendererGates: RendererReadinessGates;
};

/**
 * The collaborators `DesktopApplication` owns. Injecting a fake of this bag is
 * what makes the class testable without real stores or network transports.
 */
export type DesktopServices = {
  sessionStore: LocalSessionStore;
  settingsStore: SettingsStore;
  apiKeyStore: ApiKeyStore;
  nodeUuidStore: NodeUuidStore;
  appOtelRuntime: DesktopOtelRuntime;
  /** ISS-6334: report one auth/pairing failure onto the keyless relay pipe. */
  reportAuthFailure: (input: DesktopAuthFailureEventInput) => void;
  telemetryOrgProvider: TelemetryOrgProvider;
  appLifecycleTelemetry: DesktopAppLifecycleTelemetry;
  gatewaySigningKeyStore: GatewaySigningKeyStore;
  desktopSessionStore: DesktopSessionStore;
  desktopSessionManager: DesktopSessionManager;
  realtimeHost: DesktopRealtimeHost;
  tray: DesktopTray;
  desktopWindow: DesktopWindow;
  activityLog: ActivityLogStore;
  approvalStore: ApprovalStore;
  costReconciliation: CostReconciliationService;
  claudeCodeAnalytics: ClaudeCodeAnalyticsService;
};

/**
 * Build the desktop application's collaborators. Order mostly matches the
 * original constructor — do not reorder without checking the read-after-construct
 * dependencies (e.g. `processExceptionTelemetryBridge` must bind the runtime
 * before use).
 * Two behavior-neutral deltas vs. the original are documented in the file header
 * and inline: tray/window before the session-manager subscriptions, and
 * cost/analytics ahead of the deferred gateway cluster.
 */
export function createDesktopApplicationServices(
  options: DesktopApplicationOptions | undefined,
  host: DesktopServicesHost
): DesktopServices {
  const sessionStore = new LocalSessionStore();
  // FEA-2199: prefer the build-time-baked version (authoritative for a
  // packaged release); fall back to the runtime value, and never emit the
  // Electron `"0.0"` sentinel or the unpackaged Electron-version bleed.
  const desktopBuildVersion = resolveDesktopServiceVersion({
    buildVersion: BUILD_APP_VERSION,
    runtimeVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    logWarning: (message) => gatewayLog.warn("otel", message),
  });
  // ISS-10502 (PRD-736 decision #11): built before Observability.init so every
  // product-analytics event carries the install's node_uuid as `device_id`.
  const nodeUuidStore = new NodeUuidStore();
  // FEA-3425 (Phase 3): the host owns per-event transport selection between
  // the authenticated HTTP twins and the legacy relay socket.
  Observability.init({
    telemetrySend: (event) => host.sendDesktopTelemetry(event),
    telemetryFlush: (options) => host.flushDesktopTelemetry(options),
    analytics: {
      send: (event) => host.sendProductAnalytics(event),
      flush: (options) => host.flushProductAnalytics(options),
    },
    // ISS-9743: the SAME resolution the OTel resource and the ISS-8749 request
    // attribution read, not a third one. A raw `app.getVersion()` here reported
    // the ELECTRON version on an unpackaged launch — the `43.0.0` seen in the
    // fleet, matching this app's `electron: ^43.0.0` pin — so telemetry named a
    // build version that disagreed with both of its own siblings.
    desktopClientVersion: desktopBuildVersion,
    // ISS-9743: and the version alone still names no source build — it is the
    // bare series anchor on everything that is not a release. The commit does.
    desktopBuildCommit: resolveDesktopBuildCommit(BUILD_COMMIT_HASH),
    deviceId: nodeUuidStore.getOrCreateNodeUuid(),
  });
  const settingsStore = new SettingsStore();
  // ISS-4922: bind the Local session lane's Authored-PR gate to the Labs flag.
  // `localSessionPullRequests` is a pure leaf with no store access; registering
  // the resolver once here keeps the flag read out of the list hot path's
  // signature while still failing CLOSED (ungated, today's behavior) in every
  // caller that runs before or without the composition root.
  setLocalSessionAuthoredPrGateResolver(() =>
    settingsStore.getFlag(
      DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY
    )
  );
  // ISS-7830: bind the thread-viewership override to its Labs flag, for the same
  // reason as the gate above — the sync-source read path owns no settings store.
  setThreadViewershipSignalResolver(() =>
    settingsStore.getFlag(DESKTOP_THREAD_VIEWERSHIP_SIGNAL_FEATURE_FLAG_KEY)
  );
  const apiKeyStore = new ApiKeyStore();
  // FEA-1996: resolves the authenticated org id from the API key for
  // multiplayer telemetry attribution. Gated on key presence, so single-player
  // telemetry can never carry org identity.
  const telemetryOrgProvider = createTelemetryOrgProvider({
    apiKeyStore,
    getApiOrigin: () => settingsStore.getApiOrigin(),
  });
  // FEA-2199: gate telemetry network egress so only a real packaged install
  // phones home. Unpackaged dev/E2E/CI launches keep buffering locally but
  // never ship to the prod relay → Datadog/PostHog (they were flooding the
  // fleet `version` facet with `0.0`/Electron-version events). An explicit
  // CLOSEDLOOP_DESKTOP_TELEMETRY_EGRESS override allows deliberate relay testing.
  const telemetryEgressEnabled = resolveDesktopTelemetryEgressEnabled({
    isPackaged: app.isPackaged,
    env: process.env,
  });
  // ISS-12211: keyless OTLP egress over HTTPS to the API host's
  // /desktop/otlp route, falling back to the relay /telemetry lane (FEA-1993,
  // its own isolated socket) when that route answers 404. The runtime owns
  // start/stop; this is inert when OTEL_SDK_DISABLED is set. FEA-2199: omitted
  // entirely off-prod so the always-on local SDK runs without any network
  // egress. Held in a local rather than inlined because ISS-6334 also reads its
  // delivery counters — reaching the SDK is not reaching the ingress.
  const relayTelemetryTransport = telemetryEgressEnabled
    ? createApiOtlpTelemetryTransport({
        getApiOrigin: () => settingsStore.getApiOrigin(),
        fallback: createRelayTelemetryTransport({
          getRelayOrigin: () => settingsStore.getRelayOrigin(),
        }),
      })
    : undefined;
  // ISS-8749: publish the build identity every first-party cloud request
  // attests to. Hoisted off the OTel resource above rather than resolved a
  // second time, so the version a desktop record carries and the version the
  // API span records for the request that produced it are the same string by
  // construction — two resolutions could disagree and nothing would say so.
  // Deferred, like every other reader of the installation id: the store behind
  // it is assigned from THIS function's return value, so an eager read throws
  // and kills startup.
  setDesktopClientAttributionResolver(() => ({
    installationId: host.getNodeUuidForTelemetry(),
    clientVersion: desktopBuildVersion,
  }));
  const appOtelRuntime = createDesktopOtelRuntime({
    appVersion: desktopBuildVersion,
    env: process.env,
    getAppInstallationId: () => host.getNodeUuidForTelemetry(),
    getDeviceId: () => host.getNodeUuidForTelemetry(),
    getOperatingMode: () => host.getAppOperatingModeForTelemetry(),
    getOrganizationId: () => telemetryOrgProvider.getOrganizationId(),
    isPackaged: app.isPackaged,
    telemetryTransport: relayTelemetryTransport,
  });
  processExceptionTelemetryBridge.bindRuntime(appOtelRuntime);
  genAiRequestTelemetry.bindRuntime(appOtelRuntime);
  onboardingDiscardTelemetry.bindRuntime(appOtelRuntime);
  // ISS-6334: ONE instance shared by all three auth-failure reporters, so the
  // dedupe window bounds the lane as a whole rather than per call site.
  const authFailureTelemetry = createAuthFailureTelemetry({
    emit: (input) => appOtelRuntime.emitAuthFailureEvent(input),
    getDeliveryCounters: relayTelemetryTransport
      ? () => {
          const diagnostics = relayTelemetryTransport.getDiagnostics();
          return {
            sent: diagnostics.sent,
            dropped: totalDroppedExports(diagnostics),
          };
        }
      : undefined,
  });
  const appLifecycleTelemetry = createDesktopAppLifecycleTelemetry({
    runtime: appOtelRuntime,
    getOperatingMode: () => host.getAppOperatingModeForTelemetry(),
    getOrganizationId: () => telemetryOrgProvider.getOrganizationId(),
    getAgentMonitorRuntimeStatus: () =>
      host.getAgentMonitorRuntimeStatusKindForTelemetry(),
    // ISS-11866 (R4): no transport on an egress-disabled launch, so its
    // heartbeat omits the counts instead of reporting zeros.
    getTelemetryExportCounts: relayTelemetryTransport
      ? () => relayTelemetryTransport.getDiagnostics()
      : undefined,
    logWarning: (tag, message) => gatewayLog.warn(tag, message),
  });
  const gatewaySigningKeyStore = new GatewaySigningKeyStore();
  const desktopSessionStore = new DesktopSessionStore();
  const golden = (options?.golden ?? null) !== null;
  // Window/tray/stores are built before the session-manager subscriptions so the
  // subscription callbacks can reference these siblings directly. The original
  // constructor created them after and relied on lazy `this.` access; reordering
  // is behavior-neutral because DesktopSessionManager.subscribe is register-only
  // (it does not replay current state synchronously).
  const tray = new DesktopTray({ golden });
  const desktopWindow = new DesktopWindow({
    golden,
    // ISS-4898: renderer-opened links on the CONFIGURED web-app origin (the
    // session-detail linked-artifact pills) are admitted alongside the fixed
    // production host set. Read fresh per open so switching profiles takes
    // effect without a relaunch; normalized so a trailing-slash or
    // mixed-case setting still matches the exact-origin comparison.
    resolveWebAppOrigin: () =>
      normalizeWebAppOrigin(settingsStore.getWebAppOrigin()),
    // ISS-5346: hold the reveal until the renderer's React entry has MOUNTED.
    // The pre-mount renderer-ready IPC that used to reveal the window exposed a
    // shell that was painted but not live. The waiter is bounded (fails open)
    // on the application side, and the mount notification below is what
    // releases it.
    waitForInitialRevealReadiness: () =>
      host.rendererGates.waitForInitialWindowRevealReadiness(),
    onRendererMounted: () => host.rendererGates.notifyRendererMounted(),
    onRendererReleased: () => host.rendererGates.resetRendererMounted(),
    onRendererNavigationReady: () => host.onRendererNavigationReady(),
  });
  // ISS-5037: own the native application menu (the app previously inherited
  // Electron's default one) so it can carry the "Enable Labs" checkbox. Wired
  // here, beside the tray, because this is where both collaborators the item
  // needs already exist: the settings store it reads/writes and the window it
  // notifies. A toggle broadcasts `desktop:flags-changed`, which the renderer's
  // feature-flag provider already listens for — so the sidebar's Labs section
  // appears/disappears live, with no relaunch.
  //
  // Deferred to `whenReady()` on purpose: Electron installs its DEFAULT
  // application menu at `ready`, and this composition root runs BEFORE that
  // (startup.ts constructs DesktopApplication first and only then registers
  // `app.on("ready")`), so a menu set here synchronously would be replaced by
  // the default one — the exact "Electron" menu this ticket is removing.
  // `whenReady()` resolves immediately if the app is already ready.
  app
    .whenReady()
    .then(() =>
      installApplicationMenu({
        appName: app.getName(),
        platform: process.platform,
      })
    )
    // A menu that fails to install must never take the whole boot down; the
    // app is fully usable with Electron's default menu.
    .catch((error: unknown) => {
      gatewayLog.warn(
        "app-menu",
        `Application menu install failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  const activityLog = new ActivityLogStore();
  const approvalStore = new ApprovalStore({
    onChange: (pendingCount) => tray.setPendingApprovals(pendingCount),
    onNewApproval: (approval) => {
      const notification = new Notification({
        title: "Approval Required",
        body: approval.reason,
      });
      notification.on("click", () => {
        desktopWindow.showRoute("approvals");
      });
      notification.show();
    },
  });
  const desktopSessionManager = new DesktopSessionManager({
    store: desktopSessionStore,
    beginSignInAnalytics: host.beginSignInAnalytics,
    popSigner: (request) => host.signDesktopRequest(request),
    resolveApiOrigin: () =>
      normalizeAndValidateOrigin(settingsStore.getApiOrigin()),
    resolveGatewayId: () => host.getActiveGatewayId(),
    browserSignIn: {
      resolveWebAppOrigin: () =>
        normalizeWebAppOrigin(settingsStore.getWebAppOrigin()),
      resolveDeviceDescriptor: () => host.resolveDesktopDeviceDescriptor(),
      // The authorize URL is built by the manager from this exact
      // webAppOrigin + a fixed path (loopback OAuth), so there is no
      // server-supplied URL to allowlist before shell.openExternal; the
      // loopback redirect_uri is a 127.0.0.1 URL the manager owns.
      openExternal: (url) => shell.openExternal(url),
    },
    // Existing-user resolution (PRD-532 §8 / M6): read API-key presence +
    // one-time-prompt dismissal from the ApiKeyStore so the manager can derive
    // the non-blocking "Sign in with GitHub to sync" prompt. Offer only —
    // signing in stays an explicit user action.
    existingUser: {
      hasApiKey: () => apiKeyStore.getStatus().hasApiKey,
      hasDismissedPrompt: () => apiKeyStore.hasDismissedSyncPrompt(),
      persistDismissal: () => apiKeyStore.dismissSyncPrompt(),
    },
    reportAuthFailure: (input) => authFailureTelemetry.report(input),
    // One sink for every auth cause the closed telemetry enums cannot carry:
    // sign-in start/exchange failures and a `restore()` that could not settle
    // both report here. The browser-sign-in ports fall back to it rather than
    // wiring `gatewayLog` a second time.
    logDiagnostic: (message) => gatewayLog.error("desktop-auth", message),
  });
  desktopSessionManager.subscribeExistingUserResolution((resolution) => {
    desktopWindow.sendToRenderer(
      DESKTOP_EXISTING_USER_RESOLUTION_CHANGED_CHANNEL,
      resolution
    );
  });
  const replayRecordingFence = createDesktopReplayRecordingFence(
    () => desktopSessionManager.isAuthenticated(),
    () => desktopSessionManager.getState().authGeneration
  );
  registerDesktopReplayRecordingIpcHandler(ipcMain, {
    isTrustedSender: (sender) =>
      desktopWindow.isTrustedSender(sender as WebContents),
    report: replayRecordingFence.report,
  });
  // `session.defaultSession` throws before `ready` (Electron 43), and this
  // composition root runs before it (see the menu note above).
  app
    .whenReady()
    .then(() =>
      installDesktopReplayRequestAuth({
        session: session.defaultSession,
        getAccessToken: (origin) =>
          desktopSessionManager.getAccessTokenIssuedBy(origin),
        resolveApiOrigin: () =>
          normalizeAndValidateOrigin(settingsStore.getApiOrigin()),
        isRecordingSignInCurrent: replayRecordingFence.isCurrent,
      })
    )
    .catch((error: unknown) => {
      gatewayLog.warn(
        "replay-request-auth",
        `Replay request auth install failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  // Purge the cloud-transcript disk cache whenever the signed-in identity
  // changes — sign-out, refresh failure, or account/org switch (and any
  // signed-out emission, which also clears bytes orphaned by a prior session
  // that quit without signing out). A same-user restore (null-sentinel → X)
  // does not purge, so its cache survives a relaunch (FEA-3324 follow-up).
  let lastTranscriptIdentityKey: string | null = null;
  // ISS-9437: main's OWN PostHog flag assignment, resolved on main's OWN auth
  // lifecycle. Main gates its own decisions on it — the Branches server page's
  // status ordering today — and must not wait on the renderer's IPC pull to have
  // happened, which is a race main loses silently.
  const featureFlagAssignment = createDesktopMainFeatureFlagAssignmentStore({
    fetchAssignment: () =>
      fetchDesktopFeatureFlags({
        getAccessToken: () => desktopSessionManager.getAccessToken(),
        getApiOrigin: () => settingsStore.getApiOrigin(),
      }),
  });
  publishDesktopMainFeatureFlagAssignmentStore(featureFlagAssignment);
  // ISS-12048: Dev Tools overrides for main's own reads, applied only under
  // main's own eligibility check (its assignment's `dev-mode` plus a staff
  // email from its own identity fetch), re-checked on every account boundary
  // below.
  const featureFlagDevMode = createDesktopMainDevMode({
    assignment: featureFlagAssignment,
    fetchIdentity: () =>
      fetchDesktopIdentity({
        getAccessToken: () => desktopSessionManager.getAccessToken(),
        getApiOrigin: () => settingsStore.getApiOrigin(),
      }),
  });
  publishDesktopMainDevMode(featureFlagDevMode);
  featureFlagDevMode.subscribeChecked(() => {
    desktopWindow.sendToRenderer(
      DesktopDevModeIpcChannel.CheckedFeatureFlagsChanged
    );
  });
  // ISS-12552 (PRD-800 "Rollout"): main's parse policy, from the persisted
  // verdict until the flag answers. Started here, before any collector or the
  // db host, so both begin under it; a settled flip reaches the agent runtime.
  startDesktopParsePolicyController({
    settings: settingsStore,
    readOrganization: () =>
      desktopSessionManager.getAccountAdmission()?.organizationId ?? null,
  });
  // ISS-11945: the signed-out flag read is unauthenticated egress, so it takes
  // the same FEA-2199 policy as pre-auth analytics: packaged builds only.
  publishAnonymousDesktopFeatureFlagsSource(
    telemetryEgressEnabled
      ? {
          getApiOrigin: () => settingsStore.getApiOrigin(),
          getNodeUuid: () => host.getNodeUuidForTelemetry(),
        }
      : null
  );
  const realtimeHost = new DesktopRealtimeHost({
    getAccountAdmission: () => host.getDesktopAccountAdmission(),
    clientVersion: desktopBuildVersion,
    fetchToken: () =>
      fetchDesktopRealtimeToken({
        getAccessToken: () => desktopSessionManager.getAccessToken(),
        getApiOrigin: () =>
          normalizeAndValidateOrigin(settingsStore.getApiOrigin()),
        onUnauthorized: (token) =>
          desktopSessionManager.invalidateAccessToken(token),
      }),
  });
  const followFeatureFlagAccountBoundary = createFeatureFlagAccountBoundary({
    assignment: featureFlagAssignment,
    devMode: featureFlagDevMode,
  });
  let lastCloudAdmissionKey: string | null = null;
  desktopSessionManager.subscribe((state) => {
    host.publishDesktopAuthState(state);
    const cloudAdmission = desktopSessionManager.getAccountAdmission();
    const cloudAdmissionKey = cloudAdmission
      ? `${cloudAdmission.organizationId}\u0000${cloudAdmission.userId}\u0000${cloudAdmission.generation}`
      : null;
    if (cloudAdmissionKey !== lastCloudAdmissionKey) {
      lastCloudAdmissionKey = cloudAdmissionKey;
      host.onDesktopAccountChanged(cloudAdmission);
    }
    followFeatureFlagAccountBoundary(state);
    const identityKey = state.userId
      ? `${state.userId}:${state.organizationId ?? ""}`
      : null;
    const identityChanged =
      identityKey === null ||
      (lastTranscriptIdentityKey !== null &&
        lastTranscriptIdentityKey !== identityKey);
    lastTranscriptIdentityKey = identityKey;
    if (identityChanged) {
      purgeTranscriptCache(
        resolveTranscriptCacheDir(app.getPath("userData"))
      ).catch(() => undefined);
    }
    // PRD-532 §5.5: every authenticated transition may provision a fresh
    // managed key; the controller is single-flight and manual paste remains the
    // fallback when provisioning fails.
    if (state.status === DesktopAuthStatus.Authenticated) {
      host.maybeAutoProvisionManagedKey().catch(() => undefined);
    }
  });
  // FEA-1435/1436: nightly cost reconciliation lives entirely in main. It owns
  // the org-level vendor Admin key stores (safeStorage, never exposed to the
  // renderer) and the reconciliation store, and reconciles the local
  // genai-prices estimate against what each vendor actually billed.
  // Agent Dashboard usage rows come from the SQLite runtime. When the master
  // Agent Dashboard flag is disabled, usage loading returns no rows so the
  // dashboard code path stays inert.
  // One Anthropic Admin key store, shared by reconciliation (compares the local
  // estimate against the billed cost_report) and Claude Code analytics (reads
  // Anthropic's own per-user usage estimate). Sharing the store means a key
  // saved once powers both, and there is a single owner of the key material.
  //
  // Ordering delta (behavior-neutral): in the original constructor these two
  // built *after* the gateway/cloud/agent-sync/transcript cluster (which stays
  // inline in app.ts, deferred to a later phase) and before recovery. Here they
  // build at the factory tail, ahead of that cluster. Safe because both are pure
  // field assignment and read nothing the deferred cluster creates.
  const anthropicKeyStore = createAnthropicAdminKeyStore();
  const costReconciliation = new CostReconciliationService({
    anthropicKeyStore,
    openaiKeyStore: createOpenAiAdminKeyStore(),
    store: new ReconciliationStore(),
    loadUsageRows: () => host.loadAgentDashboardMeteredUsageRows(),
    log: (message) => gatewayLog.info("cost-reconciliation", message),
  });
  // FEA-1436: Claude Code per-user usage view. Read-only, main-only, and uses
  // the SAME Anthropic Admin key as reconciliation. The estimate it returns is
  // Anthropic's own — it never overrides the local genai-prices ledger.
  const claudeCodeAnalytics = new ClaudeCodeAnalyticsService({
    anthropicKeyStore,
    log: (message) => gatewayLog.info("claude-code-analytics", message),
  });

  return {
    sessionStore,
    settingsStore,
    apiKeyStore,
    nodeUuidStore,
    appOtelRuntime,
    reportAuthFailure: (input) => authFailureTelemetry.report(input),
    telemetryOrgProvider,
    appLifecycleTelemetry,
    gatewaySigningKeyStore,
    desktopSessionStore,
    desktopSessionManager,
    realtimeHost,
    tray,
    desktopWindow,
    activityLog,
    approvalStore,
    costReconciliation,
    claudeCodeAnalytics,
  };
}
