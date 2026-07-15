import { createRequire } from "node:module";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import type {
  RelayHttpRequestPayload,
  RelayResponseEnvelope,
} from "@repo/shared-platform/relay-request-model";
import type {
  AgentMonitorUrl,
  DesktopAuthState,
  DesktopBrowserSignInResult,
  GitHubConnectOpenRequest,
  GitHubConnectOpenResult,
} from "../renderer/types/desktop-api.js";
import type {
  AgentMonitorHooksResult,
  ManagedKeyHintState,
} from "../shared/contracts.js";
import { DesktopIdentityIpcChannel } from "../shared/desktop-identity-channel.js";
import { GATEWAY_DISPATCH_CHANNEL } from "../shared/gateway-dispatch-channel.js";
import { GitHubIntegrationStatusIpcChannel } from "../shared/github-integration-status-channel.js";
import { MOVE_TO_APPLICATIONS_IPC_CHANNEL } from "../shared/move-to-applications-ipc-channel.js";
import {
  RENDERER_OTEL_EXPORT_CHANNEL,
  type RendererOtelBridgePayload,
  type RendererOtelExportResult,
} from "../shared/renderer-otel-bridge-constants.js";
import { createProfileConfigDesktopApi } from "./profile-config-preload.js";

declare const window: {
  dispatchEvent(event: CustomEvent<unknown>): boolean;
};

/**
 * Optional preload-only desktopApi additions for renderer modes with extra IPC
 * surfaces. Legacy and disabled modes pass no extensions, so the design-system
 * database bridge is not exposed unless the design-system preload is selected.
 */
export type DesktopApiExtensions = Record<string, unknown>;

type IpcRendererLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  send: (channel: string, ...args: unknown[]) => void;
  on?: (channel: string, listener: (...args: never[]) => void) => void;
  removeListener?: (
    channel: string,
    listener: (...args: never[]) => void
  ) => void;
};
type IpcRendererEventsLike = {
  on: (channel: string, listener: (...args: never[]) => void) => void;
};
type WindowLike = {
  dispatchEvent(event: CustomEvent<unknown>): boolean;
};

type ElectronPreloadApi = {
  contextBridge: {
    exposeInMainWorld: (apiKey: string, api: unknown) => void;
  };
  ipcRenderer: IpcRendererLike & IpcRendererEventsLike;
};

/**
 * Major macOS product version (15 = Sequoia, 26 = Tahoe), or null off macOS / if
 * the version can't be read. Computed once at preload time so the renderer can
 * branch window chrome (e.g. the stoplight underlay) without an IPC round-trip.
 * `process.getSystemVersion()` is Electron's macOS *product* version ("26.3"),
 * not the Darwin kernel release `os.release()` would give.
 */
function readMacOSMajorVersion(): number | null {
  if (process.platform !== "darwin") {
    return null;
  }
  // `process.getSystemVersion` is injected by Electron and is absent in plain
  // Node (e.g. the test:node runner), so guard before calling to keep
  // createDesktopApi usable outside the Electron runtime.
  if (typeof process.getSystemVersion !== "function") {
    return null;
  }
  const version = process.getSystemVersion();
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isNaN(major) ? null : major;
}

export function createDesktopApi(ipcRendererLike: IpcRendererLike) {
  return {
    /**
     * Host platform (`process.platform`). Static value read once at preload
     * time so the renderer can branch chrome on macOS (e.g. reserving room for
     * the overlaid stoplight buttons) without an IPC round-trip.
     */
    platform: process.platform,
    /**
     * Major macOS version (or null off macOS). Lets the renderer gate the
     * stoplight underlay to the pre-Tahoe versions that actually drop the native
     * buttons on blur — see MacWindowControlsUnderlay.
     */
    macOSMajorVersion: readMacOSMajorVersion(),
    getSettings: () =>
      ipcRendererLike.invoke("desktop:get-settings") as Promise<unknown>,
    updateSettings: (partial: unknown) =>
      ipcRendererLike.invoke(
        "desktop:update-settings",
        partial
      ) as Promise<unknown>,
    getRuntimeStatus: () =>
      ipcRendererLike.invoke("desktop:get-runtime-status") as Promise<unknown>,
    listCommandSigningKeys: () =>
      ipcRendererLike.invoke(
        "desktop:list-command-signing-keys"
      ) as Promise<unknown>,
    listAuthorizedKeys: () =>
      ipcRendererLike.invoke(
        "desktop:list-authorized-keys"
      ) as Promise<unknown>,
    authorizeKey: (payload: unknown) =>
      ipcRendererLike.invoke(
        "desktop:authorize-key",
        payload
      ) as Promise<unknown>,
    removeAuthorizedKey: (fingerprint: string) =>
      ipcRendererLike.invoke(
        "desktop:remove-authorized-key",
        fingerprint
      ) as Promise<unknown>,
    listOrgPublicKeys: () =>
      ipcRendererLike.invoke(
        "desktop:list-org-public-keys"
      ) as Promise<unknown>,
    approveOrgPublicKey: (fingerprint: string) =>
      ipcRendererLike.invoke(
        "desktop:approve-org-public-key",
        fingerprint
      ) as Promise<unknown>,
    rejectOrgPublicKey: (fingerprint: string) =>
      ipcRendererLike.invoke(
        "desktop:reject-org-public-key",
        fingerprint
      ) as Promise<unknown>,
    authorizeCommandSigningKey: (fingerprint: string) =>
      ipcRendererLike.invoke(
        "desktop:authorize-command-signing-key",
        fingerprint
      ) as Promise<unknown>,
    revokeCommandSigningKey: (fingerprint: string) =>
      ipcRendererLike.invoke(
        "desktop:revoke-command-signing-key",
        fingerprint
      ) as Promise<unknown>,
    getActivityEvents: () =>
      ipcRendererLike.invoke("desktop:get-activity-events") as Promise<unknown>,
    clearActivityEvents: () =>
      ipcRendererLike.invoke(
        "desktop:clear-activity-events"
      ) as Promise<unknown>,
    getPendingApprovals: () =>
      ipcRendererLike.invoke(
        "desktop:get-pending-approvals"
      ) as Promise<unknown>,
    approveApproval: (approvalId: string) =>
      ipcRendererLike.invoke(
        "desktop:approve-approval",
        approvalId
      ) as Promise<unknown>,
    denyApproval: (approvalId: string) =>
      ipcRendererLike.invoke(
        "desktop:deny-approval",
        approvalId
      ) as Promise<unknown>,
    alwaysAllowApproval: (approvalId: string) =>
      ipcRendererLike.invoke(
        "desktop:always-allow-approval",
        approvalId
      ) as Promise<unknown>,
    clearPendingApprovals: () =>
      ipcRendererLike.invoke(
        "desktop:clear-pending-approvals"
      ) as Promise<unknown>,
    getResolvedApprovals: () =>
      ipcRendererLike.invoke(
        "desktop:get-resolved-approvals"
      ) as Promise<unknown>,
    clearResolvedApprovals: () =>
      ipcRendererLike.invoke(
        "desktop:clear-resolved-approvals"
      ) as Promise<unknown>,
    getApiKeyStatus: () =>
      ipcRendererLike.invoke("desktop:get-api-key-status") as Promise<unknown>,
    setApiKey: (apiKey: string) =>
      ipcRendererLike.invoke("desktop:set-api-key", apiKey) as Promise<unknown>,
    clearApiKey: () =>
      ipcRendererLike.invoke("desktop:clear-api-key") as Promise<unknown>,
    // FEA-1435/1436: vendor Admin key intake + cost reconciliation. The bridge only
    // ever moves existence-only statuses, persisted drift rows, and key-free run
    // summaries — never the Admin key material itself (main-process only).
    getAdminKeyStatuses: () =>
      ipcRendererLike.invoke(
        "desktop:get-admin-key-statuses"
      ) as Promise<unknown>,
    setAdminKey: (vendor: string, key: string) =>
      ipcRendererLike.invoke("desktop:set-admin-key", {
        vendor,
        key,
      }) as Promise<unknown>,
    clearAdminKey: (vendor: string) =>
      ipcRendererLike.invoke(
        "desktop:clear-admin-key",
        vendor
      ) as Promise<unknown>,
    runCostReconciliation: () =>
      ipcRendererLike.invoke(
        "desktop:run-cost-reconciliation"
      ) as Promise<unknown>,
    listCostReconciliation: (query?: unknown) =>
      ipcRendererLike.invoke(
        "desktop:list-cost-reconciliation",
        query
      ) as Promise<unknown>,
    // FEA-1436: Claude Code per-user usage (Anthropic's own estimate). Returns
    // per-actor usage rows only — never any Admin key material.
    getClaudeCodeAnalytics: (query?: unknown) =>
      ipcRendererLike.invoke(
        "desktop:get-claude-code-analytics",
        query
      ) as Promise<unknown>,
    getCloudCommandsPaused: () =>
      ipcRendererLike.invoke(
        "desktop:get-cloud-commands-paused"
      ) as Promise<unknown>,
    setCloudCommandsPaused: (paused: boolean) =>
      ipcRendererLike.invoke(
        "desktop:set-cloud-commands-paused",
        paused
      ) as Promise<unknown>,
    getCloudConnectionEnabled: () =>
      ipcRendererLike.invoke(
        "desktop:get-cloud-connection-enabled"
      ) as Promise<unknown>,
    setCloudConnectionEnabled: (enabled: boolean) =>
      ipcRendererLike.invoke(
        "desktop:set-cloud-connection-enabled",
        enabled
      ) as Promise<unknown>,
    getOnboardingState: () =>
      ipcRendererLike.invoke(
        "desktop:get-onboarding-state"
      ) as Promise<unknown>,
    completeOnboarding: (payload: unknown) =>
      ipcRendererLike.invoke(
        "desktop:complete-onboarding",
        payload
      ) as Promise<unknown>,
    // FEA-1333: mark the one-time Agent Dashboard welcome as seen.
    markDashboardWelcomeSeen: () =>
      ipcRendererLike.invoke("desktop:mark-dashboard-welcome-seen") as Promise<{
        ok: boolean;
      }>,
    startDeviceOnboarding: (payload: unknown) =>
      ipcRendererLike.invoke(
        "desktop:start-device-onboarding",
        payload
      ) as Promise<unknown>,
    dismissOnboardingPopup: (payload: { permanent: boolean }) =>
      ipcRendererLike.invoke(
        "desktop:dismiss-onboarding-popup",
        payload
      ) as Promise<unknown>,
    onboardingPopupCta: () =>
      ipcRendererLike.invoke(
        "desktop:onboarding-popup-cta"
      ) as Promise<unknown>,
    pickSandboxDirectory: () =>
      ipcRendererLike.invoke("desktop:pick-sandbox-directory") as Promise<{
        path: string;
        isGitRepo: boolean;
        suggestedPath: string | undefined;
      } | null>,
    inspectSandboxPath: (path: string) =>
      ipcRendererLike.invoke("desktop:inspect-sandbox-path", path) as Promise<{
        path: string;
        isGitRepo: boolean;
        suggestedPath: string | undefined;
      } | null>,
    getDangerousAutoApprove: () =>
      ipcRendererLike.invoke(
        "desktop:get-dangerous-auto-approve"
      ) as Promise<boolean>,
    setDangerousAutoApprove: (enabled: boolean) =>
      ipcRendererLike.invoke(
        "desktop:set-dangerous-auto-approve",
        enabled
      ) as Promise<boolean>,
    removeAlwaysAllowRule: (ruleId: string) =>
      ipcRendererLike.invoke(
        "desktop:remove-always-allow-rule",
        ruleId
      ) as Promise<unknown>,
    checkForUpdate: () =>
      ipcRendererLike.invoke("desktop:check-for-update") as Promise<unknown>,
    applyUpdate: () =>
      ipcRendererLike.invoke("desktop:apply-update") as Promise<unknown>,
    moveToApplications: async () =>
      (await ipcRendererLike.invoke(MOVE_TO_APPLICATIONS_IPC_CHANNEL)) === true,
    isDebugAuthEnabled: () =>
      ipcRendererLike.invoke(
        "desktop:is-debug-auth-enabled"
      ) as Promise<boolean>,
    mintDebugToken: (origin?: string) =>
      ipcRendererLike.invoke(
        "desktop:mint-debug-token",
        origin
      ) as Promise<unknown>,
    listRunningJobs: () =>
      ipcRendererLike.invoke("desktop:list-running-jobs") as Promise<unknown>,
    listCompletedJobs: () =>
      ipcRendererLike.invoke("desktop:list-completed-jobs") as Promise<unknown>,
    getJob: (jobId: string) =>
      ipcRendererLike.invoke("desktop:get-job", jobId) as Promise<unknown>,
    getJobLogTail: (jobId: string, lines?: number) =>
      ipcRendererLike.invoke(
        "desktop:get-job-log-tail",
        jobId,
        lines
      ) as Promise<unknown>,
    getLogs: () =>
      ipcRendererLike.invoke("desktop:get-logs") as Promise<unknown>,
    clearLogs: () =>
      ipcRendererLike.invoke("desktop:clear-logs") as Promise<unknown>,
    getLogFilePath: () =>
      ipcRendererLike.invoke("desktop:get-log-file-path") as Promise<string>,
    openLogFile: () =>
      ipcRendererLike.invoke("desktop:open-log-file") as Promise<unknown>,
    getAppVersion: () =>
      ipcRendererLike.invoke("desktop:get-app-version") as Promise<string>,
    generateCoachingTips: (prompt: string) =>
      ipcRendererLike.invoke(
        "desktop:agent-coaching:generate",
        prompt
      ) as Promise<string>,
    installCoachingArtifact: (draft: string, harness?: string) =>
      ipcRendererLike.invoke(
        "desktop:agent-coaching:install",
        draft,
        harness
      ) as Promise<string>,
    getCoachingPack: () =>
      ipcRendererLike.invoke(
        "desktop:agent-coaching:get-pack"
      ) as Promise<unknown>,
    installCoachingPack: (sourceDir: string) =>
      ipcRendererLike.invoke(
        "desktop:agent-coaching:install-pack",
        sourceDir
      ) as Promise<unknown>,
    getBinaryPaths: () =>
      ipcRendererLike.invoke("desktop:get-binary-paths") as Promise<unknown>,
    patchBinaryPaths: (patch: unknown) =>
      ipcRendererLike.invoke(
        "desktop:patch-binary-paths",
        patch
      ) as Promise<unknown>,
    detectCliTools: () =>
      ipcRendererLike.invoke("desktop:detect-cli-tools") as Promise<unknown>,
    /**
     * Engineer gateway transport (M-001): dispatch an `/api/gateway/*` request
     * to the trusted main process, which validates it (sender trust + exact-path
     * allowlist + main-held auth) and loops back to the local gateway server.
     * The renderer never reaches localhost directly (contract Decision Q-002).
     */
    dispatchGateway: (payload: RelayHttpRequestPayload) =>
      ipcRendererLike.invoke(
        GATEWAY_DISPATCH_CHANNEL,
        payload
      ) as Promise<RelayResponseEnvelope>,
    exportOtelTelemetry: (payload: RendererOtelBridgePayload) =>
      ipcRendererLike.invoke(
        RENDERER_OTEL_EXPORT_CHANNEL,
        payload
      ) as Promise<RendererOtelExportResult>,
    /** Notify main that the renderer has nonblank shell content to show. */
    notifyRendererReady: () => {
      ipcRendererLike.send("desktop:renderer-ready");
    },
    // First-party desktop auth (FEA-2219). Sign-in/out + identity flow entirely
    // through the main-process DesktopSessionManager; only the short-lived access
    // token crosses here (for Authorization: Bearer attachment). The refresh
    // token and device-session secret never leave the main process.
    getDesktopAuthState: () =>
      ipcRendererLike.invoke(
        "desktop:get-desktop-auth-state"
      ) as Promise<DesktopAuthState>,
    beginDesktopSignIn: () =>
      ipcRendererLike.invoke(
        "desktop:begin-desktop-sign-in"
      ) as Promise<DesktopBrowserSignInResult>,
    cancelDesktopSignIn: () =>
      ipcRendererLike.invoke("desktop:cancel-desktop-sign-in") as Promise<void>,
    signOutDesktop: () =>
      ipcRendererLike.invoke("desktop:sign-out-desktop") as Promise<void>,
    getDesktopAccessToken: () =>
      ipcRendererLike.invoke("desktop:get-desktop-access-token") as Promise<
        string | null
      >,
    getGitHubIntegrationStatus: () =>
      ipcRendererLike.invoke(
        GitHubIntegrationStatusIpcChannel.Get
      ) as Promise<GitHubIntegrationStatus | null>,
    getDesktopIdentity: () =>
      ipcRendererLike.invoke(
        DesktopIdentityIpcChannel.Get
      ) as Promise<DesktopIdentity | null>,
    openGitHubConnect: (request?: GitHubConnectOpenRequest) =>
      ipcRendererLike.invoke(
        "desktop:open-github-connect",
        request
      ) as Promise<GitHubConnectOpenResult>,
    onDesktopAuthStateChanged: (
      callback: (state: DesktopAuthState) => void
    ) => {
      const handler = ((_event: unknown, state: DesktopAuthState) =>
        callback(state)) as (...args: never[]) => void;
      ipcRendererLike.on?.("desktop:auth-state-changed", handler);
      return () => {
        ipcRendererLike.removeListener?.("desktop:auth-state-changed", handler);
      };
    },
    ...createProfileConfigDesktopApi(ipcRendererLike),
    getAgentMonitorUrl: () =>
      ipcRendererLike.invoke(
        "desktop:get-agent-monitor-url"
      ) as Promise<AgentMonitorUrl>,
    openAgentMonitor: () =>
      ipcRendererLike.invoke("desktop:open-agent-monitor") as Promise<unknown>,
    getAgentMonitorHooksEnabled: () =>
      ipcRendererLike.invoke(
        "desktop:get-agent-monitor-hooks-enabled"
      ) as Promise<boolean>,
    setAgentMonitorHooksEnabled: (enabled: boolean) =>
      ipcRendererLike.invoke(
        "desktop:set-agent-monitor-hooks-enabled",
        enabled
      ) as Promise<AgentMonitorHooksResult>,
    getAllFlags: () =>
      ipcRendererLike.invoke("desktop:get-all-flags") as Promise<unknown>,
    onFlagsChanged: (callback: () => void) => {
      ipcRendererLike.on?.("desktop:flags-changed", callback);
    },
    // FEA-1334: cold-start ingest progress for the floating progress card.
    // Resolves null when the sidecar is unreachable or has no progress yet.
    getAgentMonitorIngestProgress: () =>
      ipcRendererLike.invoke(
        "desktop:get-agent-monitor-ingest-progress"
      ) as Promise<{
        running: boolean;
        startedAt: number | null;
        updatedAt: number | null;
        finishedAt: number | null;
        total: number;
        parsed: number;
        imported: number;
        byHarness: Record<
          string,
          { total: number; parsed: number; imported: number; complete: boolean }
        >;
      } | null>,
    // Pause/resume the first-launch backfill from the import banner. The flag is
    // in-memory in the main process, so it resets to running on app restart.
    setAgentMonitorImportPaused: (paused: boolean) =>
      ipcRendererLike.invoke(
        "desktop:set-agent-monitor-import-paused",
        paused
      ) as Promise<void>,
    // FEA-1334: clear the dashboard DB and restart the sidecar so it re-imports
    // every agent session from scratch. The progress banner tracks the re-import.
    reprocessAgentLogs: () =>
      ipcRendererLike.invoke("desktop:reprocess-agent-logs") as Promise<{
        ok: boolean;
        error?: string;
      }>,
    /**
     * Returns the current state of the managed-key revival limitation hint (D5).
     * The main process reads provenance from apiKeyStore — renderer does not control
     * what is returned.
     */
    getManagedKeyHintState: () =>
      ipcRendererLike.invoke(
        "desktop:get-managed-key-hint-state"
      ) as Promise<ManagedKeyHintState>,
    /**
     * Dismisses the managed-key revival limitation hint (D5).
     * The main process records the current provenance from apiKeyStore.
     * The renderer does not supply any arguments — provenance is main-process-only.
     */
    dismissManagedKeyHint: () =>
      ipcRendererLike.invoke("desktop:dismiss-managed-key-hint") as Promise<{
        success: boolean;
      }>,
  };
}

/**
 * Expose the shared Electron desktop API to the renderer through Electron's
 * contextBridge. Optional extensions are supplied only by trusted preload
 * entrypoints selected by the main process; legacy and disabled modes pass no
 * extensions, while design-system mode adds its gated DB bridge.
 */
export function exposeDesktopApi(extensions: DesktopApiExtensions = {}): void {
  const { contextBridge, ipcRenderer } = getElectronPreloadApi();
  const desktopApi = createDesktopApi(ipcRenderer);
  contextBridge.exposeInMainWorld("desktopApi", {
    ...desktopApi,
    ...extensions,
  });
}

export function registerDesktopApiEventForwarders(
  ipcRendererLike: IpcRendererEventsLike,
  targetWindow: WindowLike
): void {
  ipcRendererLike.on("desktop:navigate-tab", (_event, tab: string) => {
    targetWindow.dispatchEvent(
      new CustomEvent("desktop:navigate-tab", { detail: tab })
    );
  });

  ipcRendererLike.on("desktop:navigate-settings-tab", (_event, tab: string) => {
    targetWindow.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", { detail: tab })
    );
  });

  ipcRendererLike.on("desktop:command-keys-changed", () => {
    targetWindow.dispatchEvent(new CustomEvent("desktop:command-keys-changed"));
  });

  ipcRendererLike.on("desktop:update-available", (_event, result) => {
    targetWindow.dispatchEvent(
      new CustomEvent("desktop:update-available", { detail: result })
    );
  });

  ipcRendererLike.on("desktop:update-status", (_event, result) => {
    targetWindow.dispatchEvent(
      new CustomEvent("desktop:update-status", { detail: result })
    );
  });

  ipcRendererLike.on("desktop:onboarding-state-changed", () => {
    targetWindow.dispatchEvent(
      new CustomEvent("desktop:onboarding-state-changed")
    );
  });

  ipcRendererLike.on("desktop:show-onboarding-popup", () => {
    targetWindow.dispatchEvent(
      new CustomEvent("desktop:show-onboarding-popup")
    );
  });
}

if (typeof window !== "undefined") {
  const { ipcRenderer } = getElectronPreloadApi();
  registerDesktopApiEventForwarders(ipcRenderer, window);
}

function getElectronPreloadApi(): ElectronPreloadApi {
  const require = createRequire(import.meta.url);
  return require("electron") as ElectronPreloadApi;
}
