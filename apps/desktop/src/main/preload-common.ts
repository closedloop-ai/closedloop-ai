import { createRequire } from "node:module";
import type {
  DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
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
  DesktopExistingUserResolution,
  GitHubConnectOpenRequest,
  GitHubConnectOpenResult,
  SandboxInspectResult,
} from "../renderer/types/desktop-api.js";
import { AgentMonitorIpcChannel } from "../shared/agent-monitor-ipc-channel.js";
import { ApiKeyIpcChannel } from "../shared/api-key-ipc-channel.js";
import { ApprovalsIpcChannel } from "../shared/approvals-ipc-channel.js";
import { BinaryPathsIpcChannel } from "../shared/binary-paths-ipc-channel.js";
import {
  CLOUD_API_FETCH_CHANNEL,
  type CloudApiFetchRequest,
  type CloudApiFetchResult,
} from "../shared/cloud-api-fetch-contract.js";
import { CloudControlIpcChannel } from "../shared/cloud-control-ipc-channel.js";
import { CoachingIpcChannel } from "../shared/coaching-ipc-channel.js";
import type { CoachingHarnessResult } from "../shared/coaching-pack-contract.js";
import type {
  AgentMonitorHooksResult,
  DesktopBootstrapOrganizationInput,
  DesktopBootstrapOrganizationResult,
  DesktopSignInOptions,
  ManagedKeyHintState,
} from "../shared/contracts.js";
import { CostReconciliationIpcChannel } from "../shared/cost-reconciliation-ipc-channel.js";
import type { NotDbGuarded } from "../shared/db-host-shutdown-contract.js";
import {
  DEAD_END_TELEMETRY_CHANNEL,
  type DeadEndTelemetryPayload,
} from "../shared/dead-end-telemetry-contract.js";
import { DebugIpcChannel } from "../shared/debug-ipc-channel.js";
import { DesktopAuthIpcChannel } from "../shared/desktop-auth-ipc-channel.js";
import { DesktopDevModeIpcChannel } from "../shared/desktop-dev-mode-channel.js";
import { DesktopFeatureFlagsIpcChannel } from "../shared/desktop-feature-flags-channel.js";
import { DesktopIdentityIpcChannel } from "../shared/desktop-identity-channel.js";
import { DesktopRendererEventChannel } from "../shared/desktop-renderer-event-channel.js";
import {
  DirectoryScopeIpcChannel,
  type DirectoryScopePickPayload,
} from "../shared/directory-scope-ipc-channel.js";
import {
  type DocsHelpGetPageResult,
  DocsHelpIpcChannel,
  type DocsHelpNavResult,
  type DocsHelpSearchResult,
  type DocsHelpStatus,
} from "../shared/docs-help-contract.js";
import { GATEWAY_DISPATCH_CHANNEL } from "../shared/gateway-dispatch-channel.js";
import { GitHubConnectIpcChannel } from "../shared/github-connect-opener-ipc-channel.js";
import { GitHubIntegrationStatusIpcChannel } from "../shared/github-integration-status-channel.js";
import { LogsActivityIpcChannel } from "../shared/logs-activity-ipc-channel.js";
import { ManagedKeyHintIpcChannel } from "../shared/managed-key-hint-ipc-channel.js";
import { MOVE_TO_APPLICATIONS_IPC_CHANNEL } from "../shared/move-to-applications-ipc-channel.js";
import { OnboardingIpcChannel } from "../shared/onboarding-ipc-channel.js";
import { RendererLifecycleIpcChannel } from "../shared/renderer-lifecycle-ipc-channel.js";
import {
  RENDERER_OTEL_EXPORT_CHANNEL,
  type RendererOtelBridgePayload,
  type RendererOtelExportResult,
} from "../shared/renderer-otel-bridge-constants.js";
import { RendererReadyPhase } from "../shared/renderer-ready-phase.js";
import { RuntimeInfoIpcChannel } from "../shared/runtime-info-ipc-channel.js";
import { SandboxIpcChannel } from "../shared/sandbox-ipc-channel.js";
import { SESSION_ANALYSIS_AGREEMENT_IPC_CHANNEL } from "../shared/session-analysis-agreement-channel.js";
import {
  SessionLimitsIpcChannel,
  type SessionLimitsSnapshot,
  type StatuslineCaptureResult,
} from "../shared/session-limits-channel.js";
import { SettingsIpcChannel } from "../shared/settings-ipc-channel.js";
import {
  SURFACE_ANALYTICS_IPC_CHANNEL,
  type SurfaceAnalyticsIpcPayload,
  type SurfaceAnalyticsIpcResult,
} from "../shared/surface-analytics-ipc-contract.js";
import {
  TRANSCRIPT_CANCEL_CHANNEL,
  TRANSCRIPT_FORCE_ARCHIVE_CHANNEL,
  TRANSCRIPT_PREPARE_CHANNEL,
  type TranscriptCancelRequest,
  type TranscriptForceArchiveRequest,
  type TranscriptForceArchiveResult,
  type TranscriptPrepareRequest,
  type TranscriptPrepareResult,
} from "../shared/transcript-read-contract.js";
import type { TranscriptSyncStatusSnapshot } from "../shared/transcript-sync-status-contract.js";
import { UpdateIpcChannel } from "../shared/update-ipc-channel.js";
import { registerDesktopApiEventForwarders } from "./desktop-api-event-forwarders.js";
import { createRealtimeDesktopApi } from "./desktop-realtime-preload.js";
import { createDesktopSessionReplayDesktopApi } from "./desktop-session-replay-preload.js";
import {
  DESKTOP_EXISTING_USER_RESOLUTION_CHANGED_CHANNEL,
  DesktopExistingUserIpcChannel,
} from "./ipc/desktop-existing-user-ipc.js";
import { createOnboardingLocalStateDesktopApi } from "./onboarding-local-state-preload.js";
import { createProfileConfigDesktopApi } from "./profile-config-preload.js";
import { createSettingsLocalDeviceDesktopApi } from "./settings-local-device-preload.js";
import { createSigningKeysAndApprovalsDesktopApi } from "./signing-keys-approvals-preload.js";

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
  /**
   * ISS-5262: `NotDbGuarded` makes this reject any `withDb`-backed channel, so a
   * new bridge cannot reach one without going through a helper that unwraps the
   * shutdown sentinel (see `invokeLiveDb` in `preload-design-system.ts`). Every other channel
   * is unaffected.
   */
  invoke: <TChannel extends string>(
    channel: TChannel & NotDbGuarded<TChannel>,
    ...args: unknown[]
  ) => Promise<unknown>;
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
      ipcRendererLike.invoke(
        SettingsIpcChannel.GetSettings
      ) as Promise<unknown>,
    getSessionLimits: () =>
      ipcRendererLike.invoke(
        SessionLimitsIpcChannel.Get
      ) as Promise<SessionLimitsSnapshot | null>,
    /** FEA-3492: read the statusline-capture opt-in state. */
    getStatuslineCaptureEnabled: () =>
      ipcRendererLike.invoke(
        SessionLimitsIpcChannel.GetStatuslineCaptureEnabled
      ) as Promise<boolean>,
    /** FEA-3492: opt in/out of the statusLine capture (installs/restores config). */
    setStatuslineCaptureEnabled: (enabled: boolean) =>
      ipcRendererLike.invoke(
        SessionLimitsIpcChannel.SetStatuslineCaptureEnabled,
        enabled
      ) as Promise<StatuslineCaptureResult>,
    updateSettings: (partial: unknown) =>
      ipcRendererLike.invoke(
        SettingsIpcChannel.UpdateSettings,
        partial
      ) as Promise<unknown>,
    getRuntimeStatus: () =>
      ipcRendererLike.invoke(
        RuntimeInfoIpcChannel.GetRuntimeStatus
      ) as Promise<unknown>,
    // FEA-2715 / ISS-4719: per-file transcript archive-lane status for the
    // availability UI (FEA-2716/2717). Mirrors the main-process handler in
    // `runtime-info-ipc.ts`; returns a disabled snapshot when the flag is off.
    getTranscriptSyncStatus: () =>
      ipcRendererLike.invoke(
        RuntimeInfoIpcChannel.GetTranscriptSyncStatus
      ) as Promise<TranscriptSyncStatusSnapshot>,
    /**
     * FEA-3843 / PRD-555: in-app Docs & Help bridge — search the local docs
     * index, fetch a bundled page, read the bundle status (M1), and list the
     * `meta.json` nav tree (M2/FEA-3844). Read-only; the renderer surfaces stay
     * gated on the `docsHelp` Labs flag.
     */
    docsHelp: {
      search: (query: string, limit?: number) =>
        ipcRendererLike.invoke(DocsHelpIpcChannel.Search, {
          query,
          ...(limit === undefined ? {} : { limit }),
        }) as Promise<DocsHelpSearchResult>,
      getPage: (docPath: string) =>
        ipcRendererLike.invoke(DocsHelpIpcChannel.GetPage, {
          path: docPath,
        }) as Promise<DocsHelpGetPageResult>,
      status: () =>
        ipcRendererLike.invoke(
          DocsHelpIpcChannel.Status
        ) as Promise<DocsHelpStatus>,
      /** FEA-3844 (M2): the `meta.json` nav tree (groups → pages) for the Help view. */
      nav: () =>
        ipcRendererLike.invoke(
          DocsHelpIpcChannel.Nav
        ) as Promise<DocsHelpNavResult>,
    },
    ...createSigningKeysAndApprovalsDesktopApi(ipcRendererLike),
    getActivityEvents: () =>
      ipcRendererLike.invoke(
        LogsActivityIpcChannel.GetActivityEvents
      ) as Promise<unknown>,
    clearActivityEvents: () =>
      ipcRendererLike.invoke(
        LogsActivityIpcChannel.ClearActivityEvents
      ) as Promise<unknown>,
    getApiKeyStatus: () =>
      ipcRendererLike.invoke(
        ApiKeyIpcChannel.GetApiKeyStatus
      ) as Promise<unknown>,
    setApiKey: (apiKey: string) =>
      ipcRendererLike.invoke(
        ApiKeyIpcChannel.SetApiKey,
        apiKey
      ) as Promise<unknown>,
    clearApiKey: () =>
      ipcRendererLike.invoke(ApiKeyIpcChannel.ClearApiKey) as Promise<unknown>,
    // FEA-1435/1436: vendor Admin key intake + cost reconciliation. The bridge only
    // ever moves existence-only statuses, persisted drift rows, and key-free run
    // summaries — never the Admin key material itself (main-process only).
    getAdminKeyStatuses: () =>
      ipcRendererLike.invoke(
        ApiKeyIpcChannel.GetAdminKeyStatuses
      ) as Promise<unknown>,
    setAdminKey: (vendor: string, key: string) =>
      ipcRendererLike.invoke(ApiKeyIpcChannel.SetAdminKey, {
        vendor,
        key,
      }) as Promise<unknown>,
    clearAdminKey: (vendor: string) =>
      ipcRendererLike.invoke(
        ApiKeyIpcChannel.ClearAdminKey,
        vendor
      ) as Promise<unknown>,
    runCostReconciliation: () =>
      ipcRendererLike.invoke(
        CostReconciliationIpcChannel.RunCostReconciliation
      ) as Promise<unknown>,
    listCostReconciliation: (query?: unknown) =>
      ipcRendererLike.invoke(
        CostReconciliationIpcChannel.ListCostReconciliation,
        query
      ) as Promise<unknown>,
    // FEA-1436: Claude Code per-user usage (Anthropic's own estimate). Returns
    // per-actor usage rows only — never any Admin key material.
    getClaudeCodeAnalytics: (query?: unknown) =>
      ipcRendererLike.invoke(
        CostReconciliationIpcChannel.GetClaudeCodeAnalytics,
        query
      ) as Promise<unknown>,
    getCloudCommandsPaused: () =>
      ipcRendererLike.invoke(
        CloudControlIpcChannel.GetCloudCommandsPaused
      ) as Promise<unknown>,
    setCloudCommandsPaused: (paused: boolean) =>
      ipcRendererLike.invoke(
        CloudControlIpcChannel.SetCloudCommandsPaused,
        paused
      ) as Promise<unknown>,
    getCloudConnectionEnabled: () =>
      ipcRendererLike.invoke(
        CloudControlIpcChannel.GetCloudConnectionEnabled
      ) as Promise<unknown>,
    setCloudConnectionEnabled: (enabled: boolean) =>
      ipcRendererLike.invoke(
        CloudControlIpcChannel.SetCloudConnectionEnabled,
        enabled
      ) as Promise<unknown>,
    getOnboardingState: () =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.GetOnboardingState
      ) as Promise<unknown>,
    completeOnboarding: (payload: unknown) =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.CompleteOnboarding,
        payload
      ) as Promise<unknown>,
    // FEA-1333: mark the one-time Agent Dashboard welcome as seen.
    markDashboardWelcomeSeen: () =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.MarkDashboardWelcomeSeen
      ) as Promise<{
        ok: boolean;
      }>,
    // PRD-532 (M4) → FEA-4103: legacy sync-consent tier setter, kept as a
    // backward-compat alias. The main-process handler now maps the tier to its
    // canonical DataSyncLevel and routes through the same setDataSyncLevel path,
    // so it can no longer set the tier in isolation and desync the level UI.
    setSyncObservabilityTier: (tier: string) =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.SetSyncObservabilityTier,
        tier
      ) as Promise<{ tier: string }>,
    // FEA-3907: read/persist the graduated data sync level (Settings "Data &
    // Sync"). The main process derives the connectivity/sync booleans from it.
    getDataSyncLevel: () =>
      ipcRendererLike.invoke(OnboardingIpcChannel.GetDataSyncLevel) as Promise<{
        level: string;
      }>,
    setDataSyncLevel: (level: string) =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.SetDataSyncLevel,
        level
      ) as Promise<{
        level: string;
      }>,
    // ISS-7249: report one dead-end treatment — a rendered "we could not show
    // you the thing you asked for" state, the retry the user took, or what that
    // retry settled into. Closed enums, a boolean, and two bounded numbers; the
    // payload has no field that could carry a session id, a name, or a path.
    recordDeadEndTelemetry: (payload: DeadEndTelemetryPayload) =>
      ipcRendererLike.invoke(DEAD_END_TELEMETRY_CHANNEL, payload) as Promise<{
        ok: boolean;
      }>,
    // ISS-5489: read/write the post-auth sync-consent answer. The read exposes
    // the raw tier (null = never answered) because the level reconciles a
    // missing value into a real one and so cannot report "never asked".
    getSyncConsentRecord: () =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.GetSyncConsentRecord
      ) as Promise<PreloadSyncConsentRecord>,
    recordSyncConsent: (payload: {
      level: string;
      organizationId: string | null;
    }) =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.RecordSyncConsent,
        payload
      ) as Promise<{ level: string; organizationId: string | null }>,
    recordSessionAnalysisAgreement: () =>
      ipcRendererLike.invoke(
        SESSION_ANALYSIS_AGREEMENT_IPC_CHANNEL
      ) as Promise<{
        ok: boolean;
      }>,
    // ISS-5489: main pushes the post-write record so every renderer surface
    // sharing the consent snapshot moves together, not just the one that wrote.
    onSyncConsentRecordChanged: (
      callback: (record: PreloadSyncConsentRecord) => void
    ) => {
      const handler = ((_event: unknown, record: PreloadSyncConsentRecord) =>
        callback(record)) as (...args: never[]) => void;
      ipcRendererLike.on?.(
        DesktopRendererEventChannel.SyncConsentChanged,
        handler
      );
      return () => {
        ipcRendererLike.removeListener?.(
          DesktopRendererEventChannel.SyncConsentChanged,
          handler
        );
      };
    },
    startDeviceOnboarding: (payload: unknown) =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.StartDeviceOnboarding,
        payload
      ) as Promise<unknown>,
    dismissOnboardingPopup: (payload: { permanent: boolean }) =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.DismissOnboardingPopup,
        payload
      ) as Promise<unknown>,
    onboardingPopupCta: () =>
      ipcRendererLike.invoke(
        OnboardingIpcChannel.OnboardingPopupCta
      ) as Promise<unknown>,
    pickSandboxDirectory: () =>
      ipcRendererLike.invoke(
        SandboxIpcChannel.PickSandboxDirectory
      ) as Promise<SandboxInspectResult | null>,
    inspectSandboxPath: (path: string) =>
      ipcRendererLike.invoke(
        SandboxIpcChannel.InspectSandboxPath,
        path
      ) as Promise<SandboxInspectResult | null>,
    pickDirectoryScopeEntry: () =>
      ipcRendererLike.invoke(
        DirectoryScopeIpcChannel.PickDirectory
      ) as Promise<DirectoryScopePickPayload | null>,
    getDangerousAutoApprove: () =>
      ipcRendererLike.invoke(
        DebugIpcChannel.GetDangerousAutoApprove
      ) as Promise<boolean>,
    setDangerousAutoApprove: (enabled: boolean) =>
      ipcRendererLike.invoke(
        DebugIpcChannel.SetDangerousAutoApprove,
        enabled
      ) as Promise<boolean>,
    removeAlwaysAllowRule: (ruleId: string) =>
      ipcRendererLike.invoke(
        ApprovalsIpcChannel.RemoveAlwaysAllowRule,
        ruleId
      ) as Promise<unknown>,
    checkForUpdate: () =>
      ipcRendererLike.invoke(
        UpdateIpcChannel.CheckForUpdate
      ) as Promise<unknown>,
    applyUpdate: () =>
      ipcRendererLike.invoke(UpdateIpcChannel.ApplyUpdate) as Promise<unknown>,
    moveToApplications: async () =>
      (await ipcRendererLike.invoke(MOVE_TO_APPLICATIONS_IPC_CHANNEL)) === true,
    isDebugAuthEnabled: () =>
      ipcRendererLike.invoke(
        DebugIpcChannel.IsDebugAuthEnabled
      ) as Promise<boolean>,
    mintDebugToken: (origin?: string) =>
      ipcRendererLike.invoke(
        DebugIpcChannel.MintDebugToken,
        origin
      ) as Promise<unknown>,
    getLogs: () =>
      ipcRendererLike.invoke(
        LogsActivityIpcChannel.GetLogs
      ) as Promise<unknown>,
    clearLogs: () =>
      ipcRendererLike.invoke(
        LogsActivityIpcChannel.ClearLogs
      ) as Promise<unknown>,
    getLogFilePath: () =>
      ipcRendererLike.invoke(
        LogsActivityIpcChannel.GetLogFilePath
      ) as Promise<string>,
    openLogFile: () =>
      ipcRendererLike.invoke(
        LogsActivityIpcChannel.OpenLogFile
      ) as Promise<unknown>,
    getAppVersion: () =>
      ipcRendererLike.invoke(
        RuntimeInfoIpcChannel.GetAppVersion
      ) as Promise<string>,
    generateCoachingTips: (prompt: string) =>
      ipcRendererLike.invoke(
        CoachingIpcChannel.Generate,
        prompt
      ) as Promise<CoachingHarnessResult>,
    installCoachingArtifact: (draft: string, harness?: string, kind?: string) =>
      ipcRendererLike.invoke(
        CoachingIpcChannel.Install,
        draft,
        harness,
        kind
      ) as Promise<CoachingHarnessResult>,
    getCoachingPack: () =>
      ipcRendererLike.invoke(CoachingIpcChannel.GetPack) as Promise<unknown>,
    installCoachingPack: (sourceDir: string) =>
      ipcRendererLike.invoke(
        CoachingIpcChannel.InstallPack,
        sourceDir
      ) as Promise<unknown>,
    getBinaryPaths: () =>
      ipcRendererLike.invoke(
        BinaryPathsIpcChannel.GetBinaryPaths
      ) as Promise<unknown>,
    patchBinaryPaths: (patch: unknown) =>
      ipcRendererLike.invoke(
        BinaryPathsIpcChannel.PatchBinaryPaths,
        patch
      ) as Promise<unknown>,
    detectCliTools: () =>
      ipcRendererLike.invoke(
        BinaryPathsIpcChannel.DetectCliTools
      ) as Promise<unknown>,
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
    captureSurfaceAnalytics: (payload: SurfaceAnalyticsIpcPayload) =>
      ipcRendererLike.invoke(
        SURFACE_ANALYTICS_IPC_CHANNEL,
        payload
      ) as Promise<SurfaceAnalyticsIpcResult>,
    /**
     * Notify main that the renderer reached a readiness milestone. ISS-5346:
     * the phase distinguishes the pre-mount static shell from the mounted React
     * app; only the latter reveals the window. Defaults to `Shell` so an
     * untaught caller keeps the conservative pre-ISS-5346 meaning.
     */
    notifyRendererReady: (
      phase: RendererReadyPhase = RendererReadyPhase.Shell
    ) => {
      ipcRendererLike.send(RendererLifecycleIpcChannel.RendererReady, phase);
    },
    // First-party desktop auth (FEA-2219 / PLN-1138). Sign-in/out + identity
    // flow entirely through the main-process DesktopSessionManager. No
    // credential crosses this boundary at all: the renderer auth port surfaces
    // an opaque sentinel, and the cloudApiFetch bridge below attaches the real
    // access token in the main process. Refresh token and device-session
    // secret never leave main either.
    getDesktopAuthState: () =>
      ipcRendererLike.invoke(
        DesktopAuthIpcChannel.GetState
      ) as Promise<DesktopAuthState>,
    // ISS-5112/ISS-5954: `method`, the M5 `emailHint`, and the door `framing`
    // are optional and forwarded verbatim. Main validates all three (an
    // unknown value degrades to no hint), so this stays a thin pass-through.
    beginDesktopSignIn: (
      method?: DesktopSignInMethod,
      emailHint?: string,
      framing?: DesktopSignInFraming,
      options?: DesktopSignInOptions
    ) =>
      ipcRendererLike.invoke(
        DesktopAuthIpcChannel.BeginSignIn,
        method,
        emailHint,
        framing,
        options
      ) as Promise<DesktopBrowserSignInResult>,
    cancelDesktopSignIn: () =>
      ipcRendererLike.invoke(
        DesktopAuthIpcChannel.CancelSignIn
      ) as Promise<void>,
    confirmDesktopSignIn: () =>
      ipcRendererLike.invoke(
        DesktopAuthIpcChannel.ConfirmSignIn
      ) as Promise<void>,
    createBootstrapOrganization: (input: DesktopBootstrapOrganizationInput) =>
      ipcRendererLike.invoke(
        DesktopAuthIpcChannel.CreateBootstrapOrganization,
        input
      ) as Promise<DesktopBootstrapOrganizationResult>,
    signOutDesktop: () =>
      ipcRendererLike.invoke(DesktopAuthIpcChannel.SignOut) as Promise<void>,
    // Cloud-API fetch bridge (PLN-1138 D-G Option B): the renderer's shared
    // ApiAdapter marshals origin-relative cloud REST requests here; the main
    // process attaches the real Authorization header, so no access token
    // crosses this boundary.
    cloudApiFetch: (request: CloudApiFetchRequest) =>
      ipcRendererLike.invoke(
        CLOUD_API_FETCH_CHANNEL,
        request
      ) as Promise<CloudApiFetchResult>,
    // Cloud-transcript read bridge (FEA-3324 Option B2): the renderer asks main
    // to prepare a transcript by id; main mints the signed URL and streams the
    // bytes into a local cache, returning an `app://` URL. The bytes ride the
    // `app://` scheme, not this IPC channel.
    prepareTranscript: (request: TranscriptPrepareRequest) =>
      ipcRendererLike.invoke(
        TRANSCRIPT_PREPARE_CHANNEL,
        request
      ) as Promise<TranscriptPrepareResult>,
    // Abort an in-flight `prepareTranscript` by its `requestId` (FEA-3678) so the
    // main-process S3 download stops mid-stream when the user clicks Cancel,
    // instead of running to completion and wasting egress. Best-effort/idempotent.
    cancelTranscriptPrepare: (request: TranscriptCancelRequest) =>
      ipcRendererLike.invoke(
        TRANSCRIPT_CANCEL_CHANNEL,
        request
      ) as Promise<void>,
    // Force-archive override (FEA-3489): re-queue ONE oversized transcript the
    // automatic lane dead-lettered and upload it past the size cap for that file
    // only. Reuses the existing resumable upload lane in main.
    forceArchiveTranscript: (request: TranscriptForceArchiveRequest) =>
      ipcRendererLike.invoke(
        TRANSCRIPT_FORCE_ARCHIVE_CHANNEL,
        request
      ) as Promise<TranscriptForceArchiveResult>,
    getGitHubIntegrationStatus: () =>
      ipcRendererLike.invoke(
        GitHubIntegrationStatusIpcChannel.Get
      ) as Promise<GitHubIntegrationStatus | null>,
    getDesktopIdentity: () =>
      ipcRendererLike.invoke(
        DesktopIdentityIpcChannel.Get
      ) as Promise<DesktopIdentity | null>,
    // ISS-8024: the signed-in user's PostHog flag assignment, evaluated
    // server-side. `null` for every failure — the renderer reads that as
    // UNRESOLVED, so every gate stays closed.
    getDesktopFeatureFlags: () =>
      ipcRendererLike.invoke(
        DesktopFeatureFlagsIpcChannel.Get
      ) as Promise<DesktopFeatureFlagAssignment | null>,
    // ISS-12048: Dev Tools overrides for main's own flag reads. Main applies
    // them only under its own Dev Mode check, never on this call's say-so.
    setFeatureFlagOverrides: (overrides: Readonly<Record<string, boolean>>) =>
      ipcRendererLike.invoke(
        DesktopDevModeIpcChannel.SetFeatureFlagOverrides,
        overrides
      ) as Promise<boolean>,
    getMainCheckedFeatureFlags: () =>
      ipcRendererLike.invoke(
        DesktopDevModeIpcChannel.GetCheckedFeatureFlags
      ) as Promise<unknown>,
    onMainCheckedFeatureFlagsChanged: (callback: () => void) => {
      ipcRendererLike.on?.(
        DesktopDevModeIpcChannel.CheckedFeatureFlagsChanged,
        callback
      );
      return () => {
        ipcRendererLike.removeListener?.(
          DesktopDevModeIpcChannel.CheckedFeatureFlagsChanged,
          callback
        );
      };
    },
    // ISS-8753: the Electron E2E harness's seeded assignment for this launch.
    // `null` on every shipped launch — main refuses a packaged build outright
    // and refuses an unpackaged one that was not started with the harness launch
    // argument — so the renderer falls through to the real assignment above.
    getE2eSeededFeatureFlags: () =>
      ipcRendererLike.invoke(
        DesktopFeatureFlagsIpcChannel.GetE2eSeed
      ) as Promise<DesktopFeatureFlagAssignment | null>,
    openGitHubConnect: (request?: GitHubConnectOpenRequest) =>
      ipcRendererLike.invoke(
        GitHubConnectIpcChannel.Open,
        request
      ) as Promise<GitHubConnectOpenResult>,
    onDesktopAuthStateChanged: (
      callback: (state: DesktopAuthState) => void
    ) => {
      const handler = ((_event: unknown, state: DesktopAuthState) =>
        callback(state)) as (...args: never[]) => void;
      ipcRendererLike.on?.(
        DesktopRendererEventChannel.AuthStateChanged,
        handler
      );
      return () => {
        ipcRendererLike.removeListener?.(
          DesktopRendererEventChannel.AuthStateChanged,
          handler
        );
      };
    },
    // Existing-user resolution (PRD-532 §8 / M6). Only the advisory prompt state
    // + a dismissal action cross this boundary — no token, refresh token, or API
    // key.
    getExistingUserResolution: () =>
      ipcRendererLike.invoke(
        DesktopExistingUserIpcChannel.GetResolution
      ) as Promise<DesktopExistingUserResolution>,
    dismissExistingUserPrompt: () =>
      ipcRendererLike.invoke(
        DesktopExistingUserIpcChannel.DismissPrompt
      ) as Promise<void>,
    onExistingUserResolutionChanged: (
      callback: (resolution: DesktopExistingUserResolution) => void
    ) => {
      const handler = ((
        _event: unknown,
        resolution: DesktopExistingUserResolution
      ) => callback(resolution)) as (...args: never[]) => void;
      ipcRendererLike.on?.(
        DESKTOP_EXISTING_USER_RESOLUTION_CHANGED_CHANNEL,
        handler
      );
      return () => {
        ipcRendererLike.removeListener?.(
          DESKTOP_EXISTING_USER_RESOLUTION_CHANGED_CHANNEL,
          handler
        );
      };
    },
    ...createOnboardingLocalStateDesktopApi(ipcRendererLike),
    ...createProfileConfigDesktopApi(ipcRendererLike),
    ...createRealtimeDesktopApi(ipcRendererLike),
    ...createDesktopSessionReplayDesktopApi(ipcRendererLike),
    ...createSettingsLocalDeviceDesktopApi(ipcRendererLike),
    getAgentMonitorUrl: () =>
      ipcRendererLike.invoke(
        AgentMonitorIpcChannel.GetAgentMonitorUrl
      ) as Promise<AgentMonitorUrl>,
    openAgentMonitor: () =>
      ipcRendererLike.invoke(
        AgentMonitorIpcChannel.OpenAgentMonitor
      ) as Promise<unknown>,
    getAgentMonitorHooksEnabled: () =>
      ipcRendererLike.invoke(
        AgentMonitorIpcChannel.GetAgentMonitorHooksEnabled
      ) as Promise<boolean>,
    setAgentMonitorHooksEnabled: (enabled: boolean) =>
      ipcRendererLike.invoke(
        AgentMonitorIpcChannel.SetAgentMonitorHooksEnabled,
        enabled
      ) as Promise<AgentMonitorHooksResult>,
    getAllFlags: () =>
      ipcRendererLike.invoke(
        RuntimeInfoIpcChannel.GetAllFlags
      ) as Promise<unknown>,
    onFlagsChanged: (callback: () => void) => {
      ipcRendererLike.on?.(DesktopRendererEventChannel.FlagsChanged, callback);
      return () => {
        ipcRendererLike.removeListener?.(
          DesktopRendererEventChannel.FlagsChanged,
          callback
        );
      };
    },
    // FEA-1334: cold-start ingest progress for the floating progress card.
    // Resolves null when the sidecar is unreachable or has no progress yet.
    getAgentMonitorIngestProgress: () =>
      ipcRendererLike.invoke(
        AgentMonitorIpcChannel.GetAgentMonitorIngestProgress
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
        AgentMonitorIpcChannel.SetAgentMonitorImportPaused,
        paused
      ) as Promise<void>,
    // FEA-3639: re-run the boot import after the user grants a previously-denied
    // file-access permission, so the now-readable sessions backfill without an
    // app restart (the Sessions file-access prompt's Reload action).
    reimportAgentSessions: () =>
      ipcRendererLike.invoke(
        AgentMonitorIpcChannel.ReimportAgentSessions
      ) as Promise<void>,
    // FEA-1334: clear the dashboard DB and restart the sidecar so it re-imports
    // every agent session from scratch. The progress banner tracks the re-import.
    reprocessAgentLogs: () =>
      ipcRendererLike.invoke(
        AgentMonitorIpcChannel.ReprocessAgentLogs
      ) as Promise<{
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
        ManagedKeyHintIpcChannel.GetManagedKeyHintState
      ) as Promise<ManagedKeyHintState>,
    /**
     * Dismisses the managed-key revival limitation hint (D5).
     * The main process records the current provenance from apiKeyStore.
     * The renderer does not supply any arguments — provenance is main-process-only.
     */
    dismissManagedKeyHint: () =>
      ipcRendererLike.invoke(
        ManagedKeyHintIpcChannel.DismissManagedKeyHint
      ) as Promise<{
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

if (typeof window !== "undefined") {
  const { ipcRenderer } = getElectronPreloadApi();
  registerDesktopApiEventForwarders(ipcRenderer, window);
}

function getElectronPreloadApi(): ElectronPreloadApi {
  const require = createRequire(import.meta.url);
  return require("electron") as ElectronPreloadApi;
}

/** The consent record, pulled and pushed — one shape, so the two cannot drift. */
type PreloadSyncConsentRecord = {
  tier: string | null;
  organizationId: string | null;
  bound: boolean;
};
