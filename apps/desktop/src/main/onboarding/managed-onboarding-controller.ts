import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import type { MessageBoxOptions } from "electron";
import {
  isRiskyAllowedDirectory,
  normalizeScopePath,
} from "../../shared/sandbox-policy.js";
import type {
  DesktopPopHeaders,
  DesktopPopSigningRequest,
} from "../auth/desktop-pop.js";
import { provisionManagedKey } from "../auth/managed-key-provision.js";
import type { GatewaySigningKeyStore } from "../command-signing/gateway-signing-key-store.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type {
  DesktopDeviceDescriptor,
  DesktopSessionManager,
} from "../session/desktop-session-manager.js";
import type { ApiKeyStore } from "../settings/api-key-store.js";
import { isAllowedDesktopVerificationUrl } from "../settings/external-url-allowlist.js";
import {
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "../settings/origin-policy.js";
import type { SavedConfigManagedPatch } from "../settings/saved-config.js";
import { seedReposConfig } from "../settings/seed-repos-config.js";
import type { SettingsStore } from "../settings/settings-store.js";
import { Observability } from "../telemetry/observability.js";
import type { TelemetryOrgProvider } from "../telemetry/telemetry-org-identity.js";
import type { DesktopWindow } from "../window.js";
import {
  type BootstrapClaimDiagnostic,
  type BootstrapClaimResult,
  claimDesktopManagedApiKey,
  isRetryableBootstrapClaimFailure,
} from "./bootstrap-claim.js";
import {
  pollDeviceOnboarding,
  startDeviceOnboarding,
} from "./desktop-device-onboarding-client.js";
import {
  fetchTrustedDesktopConfig,
  type TrustedDesktopConfigResult,
  withSingleManagedOnboardingRetry,
} from "./managed-onboarding.js";
import {
  type ManagedOnboardingRunToken,
  ManagedOnboardingRunTracker,
} from "./managed-onboarding-run.js";
import {
  getCanonicalOnboardingHandoffPath,
  isCanonicalOnboardingHandoffPath,
  type OnboardingHandoffFailureReason,
  OnboardingHandoffQueue,
  type PendingOnboardingHandoff,
  readPendingOnboardingHandoff,
} from "./onboarding-handoff.js";
import {
  fetchOnboardingStatus,
  resolveOnboardingPopupDecision,
} from "./onboarding-popup.js";
import type {
  DesktopOnboardingState,
  ManagedOnboardingState,
} from "./onboarding-state.js";
import { isDesktopSetupCompleteFromState } from "./setup-readiness.js";

const MANAGED_ONBOARDING_RETRY_DELAY_MS = 5000;

export type ManagedOnboardingControllerDeps = {
  settingsStore: SettingsStore;
  apiKeyStore: ApiKeyStore;
  desktopSessionManager: DesktopSessionManager;
  gatewaySigningKeyStore: GatewaySigningKeyStore;
  telemetryOrgProvider: TelemetryOrgProvider;
  desktopWindow: DesktopWindow;
  isShuttingDown: () => boolean;
  showWindow: () => void;
  getActiveGatewayId: () => string;
  resolveDesktopDeviceDescriptor: () => DesktopDeviceDescriptor;
  reportDesktopPopUnavailable: (surface: string, reason: string) => void;
  signDesktopRequest: (
    request: DesktopPopSigningRequest
  ) => DesktopPopHeaders | null;
  persistActiveProfileKey: (
    apiKey: string,
    provenance: "USER_CREATED" | "DESKTOP_MANAGED"
  ) => void;
  persistActiveConfigManagedMetadata: (patch: SavedConfigManagedPatch) => void;
  reportBootstrapClaimDiagnostic: (
    diagnostic: BootstrapClaimDiagnostic
  ) => void;
  restartCloudSocket: () => void;
  isDesktopSetupComplete: () => boolean;
  /**
   * Register the OS open-file handler (electron `app.on("open-file")`). The
   * wiring owns `event.preventDefault()`; the controller only receives the path.
   */
  registerOpenFileHandler: (onOpenFile: (filePath: string) => void) => void;
  /** Show a modal message box (electron `dialog.showMessageBox`). */
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>;
  /** Open an external URL in the OS browser (electron `shell.openExternal`). */
  openExternalUrl: (url: string) => Promise<void>;
};

/**
 * Owns the desktop's managed/automated onboarding: the open-file handoff queue,
 * trusted-config + managed-key provisioning, first-device browser onboarding,
 * run lifecycle, and the onboarding popup. Extracted from DesktopApplication
 * (PLN-1359 Phase 3); behavior — including every renderer IPC channel string
 * and security check — is unchanged.
 */
export class ManagedOnboardingController {
  private readonly onboardingHandoffPath = getCanonicalOnboardingHandoffPath();
  private bootReadyForOnboarding = false;
  private processingOnboardingHandoff = false;
  private autoProvisioningManagedKey = false;
  private readonly queuedOpenFileHandoffs = new OnboardingHandoffQueue();
  private readonly managedOnboardingRuns = new ManagedOnboardingRunTracker();
  private managedOnboardingState: ManagedOnboardingState = { status: "idle" };

  private readonly deps: ManagedOnboardingControllerDeps;

  constructor(deps: ManagedOnboardingControllerDeps) {
    this.deps = deps;
  }

  markBootReadyForOnboarding(): void {
    this.bootReadyForOnboarding = true;
  }

  /**
   * Provision the security upgrade as one unit: begin a fresh run token,
   * provision under it, and report whether the run was superseded or cancelled.
   * Collapses the former begin → run → shouldStop protocol so callers never
   * touch the run token (PLN-1359 Phase 4).
   */
  async runSecurityUpgradeProvisioning(
    payload: PendingOnboardingHandoff
  ): Promise<{ cancelled: boolean }> {
    const run = this.managedOnboardingRuns.begin();
    await this.runManagedOnboardingProvisioning(payload, run);
    return {
      cancelled: this.shouldStopManagedOnboardingRun(
        run,
        "security upgrade result"
      ),
    };
  }

  registerOnboardingFileOpenHandler(): void {
    this.deps.registerOpenFileHandler((filePath) => {
      this.enqueueOnboardingFileOpen(filePath);
    });
  }

  private enqueueOnboardingFileOpen(filePath: string): void {
    if (
      !isCanonicalOnboardingHandoffPath(filePath, this.onboardingHandoffPath)
    ) {
      gatewayLog.debug(
        "onboarding-handoff",
        `Ignoring non-canonical open-file path: ${filePath}`
      );
      return;
    }

    if (!this.bootReadyForOnboarding || this.processingOnboardingHandoff) {
      this.queuedOpenFileHandoffs.enqueueCanonicalOpenFile();
      return;
    }

    this.processCanonicalOnboardingHandoff("open-file").catch((error) => {
      gatewayLog.warn(
        "onboarding-handoff",
        `Background onboarding handoff failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  async drainQueuedOnboardingHandoffs(): Promise<void> {
    if (!this.queuedOpenFileHandoffs.drainCanonicalOpenFile()) {
      return;
    }
    await this.processCanonicalOnboardingHandoff("open-file");
  }

  async processCanonicalOnboardingHandoff(
    entryPath: "open-file" | "cold-start" | "activate"
  ): Promise<void> {
    if (this.processingOnboardingHandoff || this.deps.isShuttingDown()) {
      return;
    }
    this.processingOnboardingHandoff = true;
    try {
      const result = await readPendingOnboardingHandoff(
        this.onboardingHandoffPath
      );
      if (result.kind === "absent") {
        return;
      }
      if (result.kind === "ignored") {
        this.setManagedOnboardingFailure(
          result.reason,
          handoffFailureMessage(result.reason),
          ["use_manual_setup", "retry_automated_onboarding"]
        );
        gatewayLog.warn(
          "onboarding-handoff",
          `Ignored pending onboarding handoff from ${entryPath}: ${result.reason}`
        );
        this.deps.showWindow();
        return;
      }

      await this.handleLoadedOnboardingHandoff(result.payload);
    } finally {
      this.processingOnboardingHandoff = false;
      if (
        !this.deps.isShuttingDown() &&
        this.queuedOpenFileHandoffs.hasPendingCanonicalOpenFile()
      ) {
        await this.drainQueuedOnboardingHandoffs();
      }
    }
  }

  private async handleLoadedOnboardingHandoff(
    payload: PendingOnboardingHandoff
  ): Promise<void> {
    const run = this.managedOnboardingRuns.begin();
    this.managedOnboardingState = {
      status: "awaiting-origin-confirmation",
      webAppOrigin: payload.webAppOrigin,
      message: "Waiting for URL confirmation before automated provisioning.",
    };
    this.notifyOnboardingStateChanged();
    this.deps.showWindow();

    const confirmed = await this.confirmManagedOnboardingOrigin(payload);
    if (this.shouldStopManagedOnboardingRun(run, "origin confirmation")) {
      return;
    }
    if (!confirmed) {
      this.setManagedOnboardingFailure(
        "origin_confirmation_dismissed",
        "Automated provisioning was canceled. Start a fresh onboarding attempt from the web app or use manual setup.",
        ["retry_automated_onboarding", "use_manual_setup"]
      );
      return;
    }

    await this.runManagedOnboardingProvisioning(payload, run);
  }

  private async confirmManagedOnboardingOrigin(
    payload: PendingOnboardingHandoff
  ): Promise<boolean> {
    const result = await this.deps.showMessageBox({
      type: "question",
      buttons: ["Continue", "Use manual setup"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: "Confirm Closedloop Web App URL",
      message:
        "Auto-provisioning was initiated. Please confirm this Closedloop web app URL before we continue.",
      detail: payload.webAppOrigin,
    });
    return result.response === 0;
  }

  /**
   * PRD-532 §5.5 (PR-K / M8): after unified-auth sign-in, auto-provision the
   * DESKTOP_MANAGED relay `sk_live_*` key so the user never pastes an API key
   * (§14 "zero manual API-key entry").
   *
   * The provisioned key is bound to this device's PoP public key and the request
   * is signed with the device key, so the server mints only for a caller holding
   * a live session + device key. The resulting key material stays main-process
   * only (encrypted store) and never crosses to any renderer. Idempotent: the
   * server rotates the single active managed key per device, and this method
   * skips work if the active key is already DESKTOP_MANAGED.
   */
  async maybeAutoProvisionManagedKey(): Promise<void> {
    if (this.autoProvisioningManagedKey || this.deps.isShuttingDown()) {
      return;
    }
    // Already holding a device-managed key for this profile — nothing to do.
    if (this.deps.apiKeyStore.getApiKeyProvenance() === "DESKTOP_MANAGED") {
      return;
    }

    // Claim the single-flight guard synchronously — before the first await — so a
    // reentrant call (e.g. another Authenticated setState transition) that reaches
    // the check above cannot slip past while this call is suspended on an await.
    // The whole body runs under try/finally so the guard is always released.
    this.autoProvisioningManagedKey = true;
    try {
      const accessToken =
        await this.deps.desktopSessionManager.getAccessToken();
      if (!accessToken) {
        return;
      }
      const gatewayId = this.deps.getActiveGatewayId();
      const keyPair = this.deps.gatewaySigningKeyStore.getOrCreate(gatewayId);
      if (!keyPair.ok) {
        this.deps.reportDesktopPopUnavailable(
          "managed_key_auto_provision",
          keyPair.reason
        );
        return;
      }

      const result = await provisionManagedKey({
        apiOrigin: this.deps.settingsStore.getApiOrigin(),
        gatewayId,
        gatewayPublicKeyPem: keyPair.keyPair.publicKeySpkiPem,
        accessToken,
        popSigner: (request) => this.deps.signDesktopRequest(request),
      });
      if (result.kind !== "provisioned") {
        // Non-fatal: the existing paste path remains available as a fallback.
        gatewayLog.warn(
          "managed-key-provision",
          `Auto-provision did not complete (${result.kind}); manual setup remains available.`
        );
        return;
      }
      // Store main-process only, tagged DESKTOP_MANAGED so PoP signing applies.
      this.deps.apiKeyStore.setApiKey(result.apiKey, "DESKTOP_MANAGED");
      this.deps.persistActiveProfileKey(result.apiKey, "DESKTOP_MANAGED");
      this.deps.persistActiveConfigManagedMetadata({
        apiKeySource: "DESKTOP_MANAGED",
        gatewayId,
        gatewayPublicKeyPem: keyPair.keyPair.publicKeySpkiPem,
      });
      this.deps.desktopSessionManager.refreshExistingUserResolution();
      this.deps.telemetryOrgProvider.warm();
      this.deps.restartCloudSocket();
    } finally {
      this.autoProvisioningManagedKey = false;
    }
  }

  private async runManagedOnboardingProvisioning(
    payload: PendingOnboardingHandoff,
    run: ManagedOnboardingRunToken
  ): Promise<void> {
    if (this.shouldStopManagedOnboardingRun(run, "provisioning start")) {
      return;
    }
    this.managedOnboardingState = {
      status: "provisioning",
      webAppOrigin: payload.webAppOrigin,
      message: "Fetching trusted Desktop configuration...",
    };
    this.notifyOnboardingStateChanged();

    const trustedConfig = await withSingleManagedOnboardingRetry({
      operation: () =>
        fetchTrustedDesktopConfig({ webAppOrigin: payload.webAppOrigin }),
      shouldRetry: isRetryableTrustedConfigFailure,
      delayMs: MANAGED_ONBOARDING_RETRY_DELAY_MS,
      isCancelled: () =>
        this.managedOnboardingRuns.isCancelled(run, this.deps.isShuttingDown()),
    });
    if (this.shouldStopManagedOnboardingRun(run, "trusted config result")) {
      return;
    }
    if (trustedConfig.kind !== "ok") {
      this.setManagedOnboardingFailure(
        trustedConfig.reason,
        managedOnboardingFailureMessage(trustedConfig),
        managedOnboardingRecoveryActions(trustedConfig)
      );
      return;
    }

    if (this.shouldStopManagedOnboardingRun(run, "claim start")) {
      return;
    }
    this.managedOnboardingState = {
      status: "provisioning",
      webAppOrigin: payload.webAppOrigin,
      message: "Claiming managed Desktop key...",
    };
    this.notifyOnboardingStateChanged();

    const activeGatewayId = this.deps.getActiveGatewayId();
    const claimResult = await withSingleManagedOnboardingRetry({
      operation: () =>
        claimDesktopManagedApiKey({
          apiOrigin: trustedConfig.config.apiOrigin,
          onboardingAttemptId: payload.onboardingAttemptId,
          webAppOrigin: payload.webAppOrigin,
          gatewayId: activeGatewayId,
          signingKeys: this.deps.gatewaySigningKeyStore,
          onDiagnostic: (diagnostic) =>
            this.deps.reportBootstrapClaimDiagnostic(diagnostic),
        }),
      shouldRetry: isRetryableBootstrapClaimFailure,
      delayMs: MANAGED_ONBOARDING_RETRY_DELAY_MS,
      isCancelled: () =>
        this.managedOnboardingRuns.isCancelled(run, this.deps.isShuttingDown()),
    });

    if (this.shouldStopManagedOnboardingRun(run, "claim result")) {
      return;
    }
    if (claimResult.kind === "manual_fallback") {
      this.setManagedOnboardingFailure(
        claimResult.reason,
        "Managed Desktop key setup is unavailable on this machine. Use manual API key setup.",
        ["use_manual_setup"]
      );
      return;
    }
    if (claimResult.kind === "failed") {
      this.setManagedOnboardingFailure(
        `claim_${claimResult.statusCode ?? "failed"}`,
        bootstrapClaimFailureMessage(claimResult),
        bootstrapClaimRecoveryActions(claimResult)
      );
      return;
    }

    if (this.shouldStopManagedOnboardingRun(run, "managed key persistence")) {
      return;
    }
    const keyPair = this.deps.gatewaySigningKeyStore.load(activeGatewayId);
    const sandboxBaseDirectory = normalizeScopePath(
      payload.sandboxBaseDirectory
    );
    const safeSandboxBaseDirectory =
      sandboxBaseDirectory && !isRiskyAllowedDirectory(sandboxBaseDirectory)
        ? sandboxBaseDirectory
        : null;

    // ISS-6243: commit the origins BEFORE the credential. Storing the key
    // announces a credential change, and every listener resolves the account by
    // calling `/me` against the CURRENT apiOrigin — so writing the key first
    // points that lookup at the previous cloud, which for managed onboarding is
    // a different one by definition. Neither write reads the other.
    this.deps.settingsStore.update({
      apiOrigin: trustedConfig.config.apiOrigin,
      relayOrigin: trustedConfig.config.relayOrigin,
      webAppOrigin: payload.webAppOrigin,
      ...(safeSandboxBaseDirectory
        ? {
            sandboxBaseDirectory: safeSandboxBaseDirectory,
            onboardingCompleted: true,
          }
        : { onboardingCompleted: false }),
    });
    this.deps.apiKeyStore.setApiKey(claimResult.apiKey, "DESKTOP_MANAGED");
    // The key just changed; re-derive the existing-user sync-prompt resolution
    // (PRD-532 §8 / M6) so it doesn't go stale after managed onboarding.
    this.deps.desktopSessionManager.refreshExistingUserResolution();
    // Warm after the apiOrigin is committed so org resolution targets the
    // freshly-configured cloud origin, not the prior one.
    this.deps.telemetryOrgProvider.warm();
    const activeConfig =
      this.deps.settingsStore.ensureActiveConfigForCurrentOrigins();
    this.deps.apiKeyStore.saveProfileKey(
      activeConfig.id,
      claimResult.apiKey,
      "DESKTOP_MANAGED"
    );
    this.deps.settingsStore.updateConfigManagedMetadata(activeConfig.id, {
      apiKeySource: "DESKTOP_MANAGED",
      gatewayId: activeGatewayId,
      ...(keyPair.ok
        ? { gatewayPublicKeyPem: keyPair.keyPair.publicKeySpkiPem }
        : {}),
      desktopSecurityUpgradeProtocolVersion: 1,
      pendingOnboardingAttemptId: null,
    });

    if (safeSandboxBaseDirectory) {
      if (this.shouldStopManagedOnboardingRun(run, "repo config seeding")) {
        return;
      }
      await seedReposConfig(safeSandboxBaseDirectory, {
        isCancelled: () =>
          this.managedOnboardingRuns.isCancelled(
            run,
            this.deps.isShuttingDown()
          ),
      });
      if (this.shouldStopManagedOnboardingRun(run, "completion state update")) {
        return;
      }
      this.managedOnboardingState = {
        status: "idle",
        webAppOrigin: payload.webAppOrigin,
        message: "Automated onboarding completed.",
      };
      this.deps.restartCloudSocket();
      this.notifyOnboardingStateChanged();
      return;
    }

    this.managedOnboardingState = {
      status: "sandbox-required",
      webAppOrigin: payload.webAppOrigin,
      message: "Choose a safe sandbox directory to finish Desktop setup.",
      recoveryActions: ["choose_sandbox", "use_manual_setup"],
    };
    this.notifyOnboardingStateChanged();
    this.deps.showWindow();
  }

  async startDesktopFirstDeviceOnboarding(
    webAppOriginInput?: string
  ): Promise<{ status: "approved" | "pending"; verificationUrl?: string }> {
    const webAppOrigin = normalizeWebAppOrigin(
      webAppOriginInput || this.deps.settingsStore.getWebAppOrigin()
    );
    // Reuse the single device-descriptor construction shared with the
    // first-party sign-in flow (gateway id + public key + machine info) so the
    // two call sites can't drift; it throws with the same "signing key
    // unavailable" message when the key store can't provide the active key.
    const deviceDescriptor = this.deps.resolveDesktopDeviceDescriptor();

    const apiOrigin = normalizeAndValidateOrigin(
      this.deps.settingsStore.getApiOrigin()
    );
    // Shared device-onboarding client (FEA-2219): the same /start + /poll
    // contract the first-party desktop sign-in flow uses. This managed-API-key
    // flow differs only in its post-approval step (origin confirmation +
    // provisioning), so it owns the loop while delegating the HTTP + parsing.
    const started = await startDeviceOnboarding({
      apiOrigin,
      webAppOrigin,
      ...deviceDescriptor,
    });
    if (!started.ok) {
      throw new Error("Could not start browser connection");
    }
    const start = started.value;
    // The verification URL arrives from the cloud onboarding response; require
    // it to live on the exact webAppOrigin we sent to `start` (prod, stage, or a
    // local dev server) before publishing any onboarding state or handing it to
    // the OS, so a malicious/MITM'd response cannot launch another host or a
    // file:/custom-scheme URL via shell.openExternal. Validate here (alongside
    // the other precondition failures) so a reject surfaces before
    // managedOnboardingState is set to "provisioning" and leaves the UI stuck on
    // the approval spinner.
    if (!isAllowedDesktopVerificationUrl(start.verificationUrl, webAppOrigin)) {
      throw new Error("Could not start browser connection");
    }

    const run = this.managedOnboardingRuns.begin();
    this.managedOnboardingState = {
      status: "provisioning",
      webAppOrigin,
      message: "Waiting for browser approval...",
    };
    this.notifyOnboardingStateChanged();
    await this.deps.openExternalUrl(start.verificationUrl);

    const pollIntervalMs = Math.max(1000, start.pollIntervalSeconds * 1000);
    const expiresAtMs = Date.parse(start.expiresAt);
    while (
      !this.managedOnboardingRuns.isCancelled(
        run,
        this.deps.isShuttingDown()
      ) &&
      expiresAtMs > Date.now()
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const polled = await pollDeviceOnboarding({
        apiOrigin,
        deviceSessionId: start.deviceSessionId,
        deviceSessionSecret: start.deviceSessionSecret,
      });
      // Preserve the prior semantics: keep polling through any error (network,
      // 4xx, 5xx, or an unparseable body) until the device session resolves to
      // a terminal decision or the start window expires.
      if (!polled.ok) {
        continue;
      }
      const decision = polled.value;
      if (decision.status === DesktopDeviceSessionStatus.Pending) {
        continue;
      }
      if (decision.status === DesktopDeviceSessionStatus.Approved) {
        const confirmed = await this.confirmManagedOnboardingOrigin({
          onboardingAttemptId: decision.onboardingAttemptId,
          webAppOrigin: decision.webAppOrigin,
          createdAt: new Date().toISOString(),
        });
        if (!confirmed) {
          this.setManagedOnboardingFailure(
            "origin_confirmation_dismissed",
            "Browser connection was canceled. Use manual setup or start again.",
            ["use_manual_setup", "retry_automated_onboarding"]
          );
          return {
            status: "pending",
            verificationUrl: start.verificationUrl,
          };
        }
        await this.runManagedOnboardingProvisioning(
          {
            onboardingAttemptId: decision.onboardingAttemptId,
            webAppOrigin: decision.webAppOrigin,
            sandboxBaseDirectory:
              this.deps.settingsStore.getSandboxBaseDirectory(),
            createdAt: new Date().toISOString(),
          },
          run
        );
        return {
          status: "approved",
          verificationUrl: start.verificationUrl,
        };
      }
      // Denied or expired: a terminal non-approval decision.
      this.setManagedOnboardingFailure(
        `device_session_${decision.status}`,
        "Browser connection was not approved. Use manual setup or start again.",
        ["use_manual_setup", "retry_automated_onboarding"]
      );
      return { status: "pending", verificationUrl: start.verificationUrl };
    }

    this.setManagedOnboardingFailure(
      "device_session_expired",
      "Browser connection expired. Use manual setup or start again.",
      ["use_manual_setup", "retry_automated_onboarding"]
    );
    return { status: "pending", verificationUrl: start.verificationUrl };
  }

  private shouldStopManagedOnboardingRun(
    run: ManagedOnboardingRunToken,
    stage: string
  ): boolean {
    if (
      !this.managedOnboardingRuns.isCancelled(run, this.deps.isShuttingDown())
    ) {
      return false;
    }
    gatewayLog.debug(
      "managed-onboarding",
      `Skipping stale managed onboarding continuation at ${stage}.`
    );
    return true;
  }

  cancelManagedOnboardingForUserChange(reason: string): void {
    this.managedOnboardingRuns.cancel();
    if (this.managedOnboardingState.status === "idle") {
      return;
    }
    gatewayLog.debug(
      "managed-onboarding",
      `Canceled automated onboarding because ${reason}.`
    );
    this.managedOnboardingState = { status: "idle" };
    this.notifyOnboardingStateChanged();
  }

  private setManagedOnboardingFailure(
    reason: string,
    message: string,
    recoveryActions: ManagedOnboardingState["recoveryActions"]
  ): void {
    this.managedOnboardingState = {
      status: "failed",
      message,
      recoveryActions,
    };
    gatewayLog.warn("managed-onboarding", `${reason}: ${message}`);
    this.notifyOnboardingStateChanged();
    this.deps.showWindow();
  }

  private notifyOnboardingStateChanged(): void {
    this.deps.desktopWindow.sendToRenderer("desktop:onboarding-state-changed");
  }

  async maybeShowOnboardingPopup(): Promise<void> {
    try {
      if (this.deps.settingsStore.getOnboardingPopupDismissedPermanent()) {
        return;
      }
      if (!this.deps.isDesktopSetupComplete()) {
        return;
      }
      const apiKey = this.deps.apiKeyStore.getApiKey();
      if (!apiKey) {
        return;
      }
      const apiOrigin = this.deps.settingsStore.getApiOrigin();
      const statusResult = await fetchOnboardingStatus({ apiOrigin, apiKey });
      const decision = resolveOnboardingPopupDecision({
        setupComplete: true,
        dismissedPermanent: false,
        statusResult,
      });
      if (decision === "skip") {
        return;
      }
      if (decision === "suppress") {
        this.deps.settingsStore.setOnboardingPopupDismissedPermanent(true);
        Observability.onboardingPopupSuppressedAuto();
        return;
      }
      this.deps.desktopWindow.sendToRenderer("desktop:show-onboarding-popup");
      Observability.onboardingPopupShown();
    } catch (error) {
      gatewayLog.warn(
        "onboarding-popup",
        `maybeShowOnboardingPopup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getOnboardingState(): DesktopOnboardingState {
    const settings = this.deps.settingsStore.getAll();
    return {
      completed: isDesktopSetupCompleteFromState({
        onboardingCompleted: settings.onboardingCompleted,
        sandboxBaseDirectory: settings.sandboxBaseDirectory,
        hasApiKey: this.deps.apiKeyStore.getStatus().hasApiKey,
      }),
      settings: {
        ...settings,
        sandboxBaseDirectory:
          normalizeScopePath(settings.sandboxBaseDirectory) ??
          settings.sandboxBaseDirectory,
      },
      hasStoredApiKey: this.deps.apiKeyStore.getStatus().hasApiKey,
      managedProvisioning: this.managedOnboardingState,
    };
  }
}

function handoffFailureMessage(reason: OnboardingHandoffFailureReason): string {
  switch (reason) {
    case "stale":
      return "The automated onboarding handoff expired. Start a fresh onboarding attempt from the web app.";
    case "invalid_origin":
      return "The automated onboarding handoff contained an invalid web app URL. Use manual setup or start again from the web app.";
    case "read_failed":
      return "Desktop could not read the automated onboarding handoff. Use manual setup or start again from the web app.";
    case "delete_failed":
      return "Desktop could not consume the automated onboarding handoff safely. Use manual setup or start again from the web app.";
    default:
      return "The automated onboarding handoff was invalid. Use manual setup or start again from the web app.";
  }
}

function isRetryableTrustedConfigFailure(
  result: TrustedDesktopConfigResult
): boolean {
  return result.kind === "failed" && result.retryable;
}

function managedOnboardingFailureMessage(
  result: Exclude<TrustedDesktopConfigResult, { kind: "ok" }>
): string {
  if (result.retryable) {
    return "Desktop could not reach the trusted web app config after retrying. Start a fresh onboarding attempt or use manual setup.";
  }
  if (result.reason === "unsupported_protocol") {
    return "This Closedloop web app does not support this Desktop onboarding protocol. Use manual setup.";
  }
  return "Desktop could not validate the trusted web app config. Use manual setup or start again from the web app.";
}

function managedOnboardingRecoveryActions(
  result: Exclude<TrustedDesktopConfigResult, { kind: "ok" }>
): ManagedOnboardingState["recoveryActions"] {
  return result.retryable
    ? ["retry_automated_onboarding", "use_manual_setup"]
    : ["use_manual_setup"];
}

function bootstrapClaimFailureMessage(
  result: Exclude<BootstrapClaimResult, { kind: "claimed" | "manual_fallback" }>
): string {
  switch (result.statusCode) {
    case 401:
      return "The onboarding attempt expired or was already used. Start a fresh onboarding attempt from the web app.";
    case 400:
    case 403:
      return "The automated onboarding request was rejected. Use manual setup.";
    case 409:
      return "Desktop managed-key rotation conflicted with another active attempt. Start a fresh onboarding attempt or use manual setup.";
    case 502:
    case 503:
      if (result.retryable === false) {
        return "Desktop could not claim a managed key. Start a fresh onboarding attempt or use manual setup.";
      }
      return "Desktop could not claim a managed key after retrying. Start a fresh onboarding attempt or use manual setup.";
    default:
      return (
        result.error ||
        "Desktop could not claim a managed key. Use manual setup."
      );
  }
}

function bootstrapClaimRecoveryActions(
  result: Exclude<BootstrapClaimResult, { kind: "claimed" | "manual_fallback" }>
): ManagedOnboardingState["recoveryActions"] {
  switch (result.statusCode) {
    case 400:
    case 403:
      return ["use_manual_setup"];
    default:
      return ["retry_automated_onboarding", "use_manual_setup"];
  }
}
