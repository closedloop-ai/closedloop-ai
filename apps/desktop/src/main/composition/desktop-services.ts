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
 * into `DesktopApplication` (`onApprove: (fp) => app.approveOrganizationCommandPublicKey(fp)`),
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
import { app, Notification, shell } from "electron";
import { BUILD_APP_VERSION } from "../../shared/build-info.js";
import { DesktopAuthStatus } from "../../shared/contracts.js";
import {
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_DISPLAYED_STATUS_PARITY_FEATURE_FLAG_KEY,
} from "../../shared/feature-flags.js";
import { installApplicationMenu } from "../app-menu.js";
import { ApprovalStore } from "../approvals/approval-store.js";
import type {
  DesktopPopHeaders,
  DesktopPopSigningRequest,
} from "../auth/desktop-pop.js";
import { LocalSessionStore } from "../auth/local-session-store.js";
import { AuthorizedCommandKeyStore } from "../command-signing/authorized-command-key-store.js";
import type { OrganizationCommandPublicKey } from "../command-signing/authorized-public-keys-client.js";
import { BrowserCommandKeyAppLifecycle } from "../command-signing/command-key-app-lifecycle.js";
import { CommandKeyReconciler } from "../command-signing/command-key-reconciler.js";
import type { CommandKeyReconciliationReason } from "../command-signing/command-key-target-context.js";
import { CommandSignatureVerifier } from "../command-signing/command-signature-verifier.js";
import { GatewaySigningKeyStore } from "../command-signing/gateway-signing-key-store.js";
import { PendingCommandKeyNotifier } from "../command-signing/pending-command-key-notifier.js";
import {
  createAnthropicAdminKeyStore,
  createOpenAiAdminKeyStore,
} from "../cost/admin-key-store.js";
import { ClaudeCodeAnalyticsService } from "../cost/claude-code-analytics-service.js";
import { CostReconciliationService } from "../cost/cost-reconciliation-service.js";
import { ReconciliationStore } from "../cost/reconciliation-store.js";
import type { MeteredUsageRow } from "../cost/reconciliation-worker.js";
import { ActivityLogStore } from "../diagnostics/activity-log-store.js";
import type { CommandSigningKeysState } from "../ipc/command-signing-keys-ipc.js";
import { DESKTOP_EXISTING_USER_RESOLUTION_CHANGED_CHANNEL } from "../ipc/desktop-existing-user-ipc.js";
import { JobStore } from "../jobs/job-store.js";
import type { RendererReadinessGates } from "../lifecycle/renderer-readiness-gates.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { LoopCompletedNotifier } from "../loop/loop-completed-notifier.js";
import { LoopTokenStore } from "../loop/loop-token-store.js";
import type {
  DesktopAuthState,
  DesktopDeviceDescriptor,
} from "../session/desktop-session-manager.js";
import { DesktopSessionManager } from "../session/desktop-session-manager.js";
import { DesktopSessionStore } from "../session/desktop-session-store.js";
import { setDisplayedStatusParityResolver } from "../session/displayed-status-parity-gate.js";
import { setLocalSessionAuthoredPrGateResolver } from "../session/local-session-pr-gate.js";
import { ApiKeyStore } from "../settings/api-key-store.js";
import type { GoldenModeConfig } from "../settings/golden-mode.js";
import {
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "../settings/origin-policy.js";
import { SettingsStore } from "../settings/settings-store.js";
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
import {
  Observability,
  type ObservabilityOptions,
  type ProductAnalyticsTransport,
} from "../telemetry/observability.js";
import { processExceptionTelemetryBridge } from "../telemetry/process-exception-telemetry-bridge.js";
import { createRelayTelemetryTransport } from "../telemetry/relay-telemetry-transport.js";
import {
  createTelemetryOrgProvider,
  type TelemetryOrgProvider,
} from "../telemetry/telemetry-org-identity.js";
import {
  purgeTranscriptCache,
  resolveTranscriptCacheDir,
} from "../transcript/transcript-read-cache.js";
import { DesktopTray } from "../tray.js";
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
  /** Show the main window (created later in the sequence). */
  showDesktopWindow: () => void;
  getActiveGatewayId: () => string;
  getNodeUuidForTelemetry: () => string;
  getAppOperatingModeForTelemetry: () => DesktopAppOperatingMode;
  getPendingCommandSigningKeysForNotification: () => Promise<
    OrganizationCommandPublicKey[]
  >;
  openBrowserCommandKeysSettings: () => void;
  approveOrganizationCommandPublicKey: (
    fingerprint: unknown
  ) => Promise<CommandSigningKeysState>;
  rejectOrganizationCommandPublicKey: (
    fingerprint: unknown
  ) => Promise<CommandSigningKeysState>;
  notifyCommandKeysChanged: () => void;
  fetchOrganizationCommandKeyClassification: (
    reason: CommandKeyReconciliationReason
  ) => ReturnType<
    BrowserCommandKeyAppLifecycle["fetchOrganizationKeyClassification"]
  >;
  notifyPendingCommandSigningKeysForOrganizationKeys: (
    organizationKeys: OrganizationCommandPublicKey[]
  ) => Promise<void>;
  /** PoP-sign an outbound desktop request (used by the session manager). */
  signDesktopRequest: (
    request: DesktopPopSigningRequest
  ) => DesktopPopHeaders | null;
  /** Resolve this device's descriptor for the browser sign-in flow. */
  resolveDesktopDeviceDescriptor: () => DesktopDeviceDescriptor;
  /** Push the latest desktop auth state to the renderer. */
  publishDesktopAuthState: (state: DesktopAuthState) => void;
  /**
   * Auto-provision the DESKTOP_MANAGED relay key after unified-auth sign-in
   * (PRD-532 §5.5 / M8). Fire-and-forget, flag-gated, single-flight; failures
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
  authorizedCommandKeys: AuthorizedCommandKeyStore;
  commandSignatureVerifier: CommandSignatureVerifier;
  commandKeyLifecycle: BrowserCommandKeyAppLifecycle;
  pendingCommandKeyNotifier: PendingCommandKeyNotifier;
  loopCompletedNotifier: LoopCompletedNotifier;
  commandKeyReconciler: CommandKeyReconciler;
  loopTokenStore: LoopTokenStore;
  nodeUuidStore: NodeUuidStore;
  appOtelRuntime: DesktopOtelRuntime;
  telemetryOrgProvider: TelemetryOrgProvider;
  appLifecycleTelemetry: DesktopAppLifecycleTelemetry;
  gatewaySigningKeyStore: GatewaySigningKeyStore;
  desktopSessionStore: DesktopSessionStore;
  desktopSessionManager: DesktopSessionManager;
  tray: DesktopTray;
  desktopWindow: DesktopWindow;
  activityLog: ActivityLogStore;
  jobStore: JobStore;
  approvalStore: ApprovalStore;
  costReconciliation: CostReconciliationService;
  claudeCodeAnalytics: ClaudeCodeAnalyticsService;
};

/**
 * Build the desktop application's collaborators. Order mostly matches the
 * original constructor — do not reorder without checking the read-after-construct
 * dependencies (e.g. `CommandSignatureVerifier` takes the key store built above
 * it, and `processExceptionTelemetryBridge` must bind the runtime before use).
 * Two behavior-neutral deltas vs. the original are documented in the file header
 * and inline: tray/window before the session-manager subscriptions, and
 * cost/analytics ahead of the deferred gateway cluster.
 */
export function createDesktopApplicationServices(
  options: DesktopApplicationOptions | undefined,
  host: DesktopServicesHost
): DesktopServices {
  const sessionStore = new LocalSessionStore();
  // FEA-3425 (Phase 3): the host owns per-event transport selection between
  // the authenticated HTTP twins and the legacy relay socket.
  Observability.init({
    telemetrySend: (event) => host.sendDesktopTelemetry(event),
    telemetryFlush: (options) => host.flushDesktopTelemetry(options),
    analytics: {
      send: (event) => host.sendProductAnalytics(event),
      flush: (options) => host.flushProductAnalytics(options),
    },
    desktopClientVersion: app.getVersion(),
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
  // ISS-4556 / ISS-4559: same shape, same reason — bind the Local lane's
  // displayed-status SSOT (row status + Status facet) to its Labs flag without
  // threading a boolean through the grandfathered list hot path. Fails CLOSED to
  // today's behavior in every caller that runs before or without this root.
  setDisplayedStatusParityResolver(() =>
    settingsStore.getFlag(
      DESKTOP_SESSIONS_DISPLAYED_STATUS_PARITY_FEATURE_FLAG_KEY
    )
  );
  const apiKeyStore = new ApiKeyStore();
  const authorizedCommandKeys = new AuthorizedCommandKeyStore();
  const commandSignatureVerifier = new CommandSignatureVerifier({
    authorizedKeys: authorizedCommandKeys,
  });
  const commandKeyLifecycle = new BrowserCommandKeyAppLifecycle({
    getActiveGatewayId: () => host.getActiveGatewayId(),
    log: (message) => gatewayLog.info("command-keys", message),
  });
  const pendingCommandKeyNotifier = new PendingCommandKeyNotifier({
    getPendingKeys: () => host.getPendingCommandSigningKeysForNotification(),
    createNotification: (options) => new Notification(options),
    supportsActions: () => process.platform === "darwin",
    onOpenSettings: () => host.openBrowserCommandKeysSettings(),
    onApprove: async (fingerprint) => {
      await host.approveOrganizationCommandPublicKey(fingerprint);
    },
    onDecline: async (fingerprint) => {
      await host.rejectOrganizationCommandPublicKey(fingerprint);
    },
    onChanged: () => host.notifyCommandKeysChanged(),
    log: (message) => gatewayLog.debug("command-keys", message),
  });
  const loopCompletedNotifier = new LoopCompletedNotifier({
    createNotification: (options) => new Notification(options),
    supportsActions: () => process.platform === "darwin",
    onViewLoop: () => host.showDesktopWindow(),
    log: (message) => gatewayLog.debug("loop-completed-notification", message),
  });
  const commandKeyReconciler = new CommandKeyReconciler({
    hasApiKey: () => Boolean(apiKeyStore.getApiKey()),
    fetchOrganizationKeyClassification: (reason) =>
      host.fetchOrganizationCommandKeyClassification(reason),
    reconcileOrganizationKeys: (fingerprints, options) =>
      authorizedCommandKeys.reconcileOrganizationKeys(fingerprints, options),
    notifyPendingKeys: (organizationKeys) =>
      host.notifyPendingCommandSigningKeysForOrganizationKeys(organizationKeys),
    onChanged: () => host.notifyCommandKeysChanged(),
    log: (level, message) => {
      gatewayLog[level]("command-keys", message);
    },
  });
  const loopTokenStore = new LoopTokenStore();
  const nodeUuidStore = new NodeUuidStore();
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
  const appOtelRuntime = createDesktopOtelRuntime({
    // FEA-2199: prefer the build-time-baked version (authoritative for a
    // packaged release); fall back to the runtime value, and never emit the
    // Electron `"0.0"` sentinel or the unpackaged Electron-version bleed.
    appVersion: resolveDesktopServiceVersion({
      buildVersion: BUILD_APP_VERSION,
      runtimeVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      logWarning: (message) => gatewayLog.warn("otel", message),
    }),
    env: process.env,
    getAppInstallationId: () => host.getNodeUuidForTelemetry(),
    getDeviceId: () => host.getNodeUuidForTelemetry(),
    getOperatingMode: () => host.getAppOperatingModeForTelemetry(),
    getOrganizationId: () => telemetryOrgProvider.getOrganizationId(),
    isPackaged: app.isPackaged,
    // FEA-1993: keyless OTLP egress over the relay (its own isolated socket,
    // independent of CloudSocketService). The runtime owns start/stop; this is
    // inert when OTEL_SDK_DISABLED is set. FEA-2199: omitted entirely off-prod
    // so the always-on local SDK runs without any network egress.
    telemetryTransport: telemetryEgressEnabled
      ? createRelayTelemetryTransport({
          getRelayOrigin: () => settingsStore.getRelayOrigin(),
        })
      : undefined,
  });
  processExceptionTelemetryBridge.bindRuntime(appOtelRuntime);
  const appLifecycleTelemetry = createDesktopAppLifecycleTelemetry({
    runtime: appOtelRuntime,
    getOperatingMode: () => host.getAppOperatingModeForTelemetry(),
    getOrganizationId: () => telemetryOrgProvider.getOrganizationId(),
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
        isLabsNavEnabled: () =>
          settingsStore.getFlag(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY),
        setLabsNavEnabled: (enabled) => {
          settingsStore.setFlag(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY, enabled);
          desktopWindow.sendToRenderer("desktop:flags-changed");
        },
      })
    )
    // A menu that fails to install must never take the whole boot down; the
    // app is fully usable without the easter egg (Labs simply stays hidden).
    .catch((error: unknown) => {
      gatewayLog.warn(
        "app-menu",
        `Application menu install failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  const activityLog = new ActivityLogStore();
  const jobStore = new JobStore();
  const approvalStore = new ApprovalStore({
    onChange: (pendingCount) => tray.setPendingApprovals(pendingCount),
    onNewApproval: (approval) => {
      const notification = new Notification({
        title: "Approval Required",
        body: approval.reason,
      });
      notification.on("click", () => {
        desktopWindow.show();
        desktopWindow.sendToRenderer("desktop:navigate-tab", "approvals");
      });
      notification.show();
    },
  });
  const desktopSessionManager = new DesktopSessionManager({
    store: desktopSessionStore,
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
      logDiagnostic: (message) => gatewayLog.error("desktop-auth", message),
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
  });
  desktopSessionManager.subscribeExistingUserResolution((resolution) => {
    desktopWindow.sendToRenderer(
      DESKTOP_EXISTING_USER_RESOLUTION_CHANGED_CHANNEL,
      resolution
    );
  });
  // Purge the cloud-transcript disk cache whenever the signed-in identity
  // changes — sign-out, refresh failure, or account/org switch (and any
  // signed-out emission, which also clears bytes orphaned by a prior session
  // that quit without signing out). A same-user restore (null-sentinel → X)
  // does not purge, so its cache survives a relaunch (FEA-3324 follow-up).
  let lastTranscriptIdentityKey: string | null = null;
  desktopSessionManager.subscribe((state) => {
    host.publishDesktopAuthState(state);
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
    // PRD-532 §5.5 (PR-K / M8): once signed in via the unified auth flow,
    // auto-provision the DESKTOP_MANAGED relay key so the user never pastes a
    // key. Flag-gated (off = today's paste behavior). Fire-and-forget; failures
    // fall back to the existing manual paste path.
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
    authorizedCommandKeys,
    commandSignatureVerifier,
    commandKeyLifecycle,
    pendingCommandKeyNotifier,
    loopCompletedNotifier,
    commandKeyReconciler,
    loopTokenStore,
    nodeUuidStore,
    appOtelRuntime,
    telemetryOrgProvider,
    appLifecycleTelemetry,
    gatewaySigningKeyStore,
    desktopSessionStore,
    desktopSessionManager,
    tray,
    desktopWindow,
    activityLog,
    jobStore,
    approvalStore,
    costReconciliation,
    claudeCodeAnalytics,
  };
}
