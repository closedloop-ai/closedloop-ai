import { createRequire } from "node:module";
import type { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
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
import {
  type AuditFileRequest,
  type AuditFileResult,
  AuditIpcChannel,
  type AuditProgressPayload,
  type AuditRunRequest,
  type AuditRunResult,
} from "../shared/audit-contract.js";
import {
  CLOUD_API_FETCH_CHANNEL,
  type CloudApiFetchRequest,
  type CloudApiFetchResult,
} from "../shared/cloud-api-fetch-contract.js";
import type { CloudReadReadinessSnapshot } from "../shared/cloud-read-readiness-contract.js";
import type { CoachingHarnessResult } from "../shared/coaching-pack-contract.js";
import type {
  AgentMonitorHooksResult,
  ManagedKeyHintState,
} from "../shared/contracts.js";
import {
  type DbGuardedChannel,
  type NotDbGuarded,
  rejectIfDbHostShuttingDown,
} from "../shared/db-host-shutdown-contract.js";
import { DesktopIdentityIpcChannel } from "../shared/desktop-identity-channel.js";
import {
  type DocsHelpGetPageResult,
  DocsHelpIpcChannel,
  type DocsHelpNavResult,
  type DocsHelpSearchResult,
  type DocsHelpStatus,
} from "../shared/docs-help-contract.js";
import { GATEWAY_DISPATCH_CHANNEL } from "../shared/gateway-dispatch-channel.js";
import { GitHubIntegrationStatusIpcChannel } from "../shared/github-integration-status-channel.js";
import { MOVE_TO_APPLICATIONS_IPC_CHANNEL } from "../shared/move-to-applications-ipc-channel.js";
import {
  RENDERER_OTEL_EXPORT_CHANNEL,
  type RendererOtelBridgePayload,
  type RendererOtelExportResult,
} from "../shared/renderer-otel-bridge-constants.js";
import { RendererReadyPhase } from "../shared/renderer-ready-phase.js";
import {
  SCHEDULED_TASKS_CHANGED_CHANNEL,
  type ScheduledTaskListItem,
  type ScheduledTaskRunItem,
  type ScheduledTaskRunsRequest,
  type ScheduledTaskSaveInput,
  ScheduledTasksIpcChannel,
  type SchedulePreviewRequest,
  type SchedulePreviewResult,
} from "../shared/scheduled-tasks-channel.js";
import {
  SessionLimitsIpcChannel,
  type SessionLimitsSnapshot,
  type StatuslineCaptureResult,
} from "../shared/session-limits-channel.js";
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
import {
  DESKTOP_EXISTING_USER_RESOLUTION_CHANGED_CHANNEL,
  DesktopExistingUserIpcChannel,
} from "./ipc/desktop-existing-user-ipc.js";
import { RuntimeInfoIpcChannel } from "./ipc/runtime-info-ipc.js";
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
  /**
   * ISS-5262: `NotDbGuarded` makes this reject any `withDb`-backed channel, so a
   * new bridge cannot reach one without going through a helper that unwraps the
   * shutdown sentinel (see {@link invokeScheduledTasksDb}). Every other channel
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

/**
 * ISS-5262 — invoke a Scheduled Tasks channel and unwrap the db-host shutdown
 * sentinel.
 *
 * Every `desktop:scheduled-tasks:*` handler is registered through `withDb`
 * (`agent-dashboard-scheduled-tasks-ipc.ts`), which now RESOLVES a payload-free
 * sentinel rather than rejecting when the db-host went away mid-read — that is
 * what stops `ipcMain.handle` printing a handler error after the shutdown
 * sequence reported clean. These bridges cast the IPC result, so without this
 * unwrap the sentinel would typecheck as the declared type and reach the
 * renderer as DATA: a truthy object read as a successful `delete`/`runNow`, and
 * a non-array handed to the routines table. It rejects instead, which is what a
 * caller already saw for any other db-host lifecycle failure.
 */
function invokeScheduledTasksDb<TResult>(
  ipcRendererLike: IpcRendererLike,
  channel: DbGuardedChannel,
  ...args: unknown[]
): Promise<TResult> {
  // The ONE sanctioned widening of a guarded channel back to `string`. It is
  // safe precisely here because this helper is the guarded path: the `.then`
  // below is what the `NotDbGuarded` constraint on `invoke` exists to force.
  const rawChannel: string = channel;
  return (ipcRendererLike.invoke(rawChannel, ...args) as Promise<TResult>).then(
    rejectIfDbHostShuttingDown
  );
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
    /**
     * FEA-3852/3853/3854 (PRD-553): the Scheduled Tasks surface. `list`/`runs`
     * read the crewd scheduler's SQLite-mirrored store (empty when the daemon is
     * off / the store is unavailable — never a reject); `create`/`update`/
     * `delete`/`toggle`/`runNow` write through the trusted-sender-gated handlers
     * (payload validated at the main boundary); `previewSchedule` validates a cron
     * and returns its next fire times; `onChanged` subscribes to the main →
     * renderer change push and returns an unsubscribe fn.
     */
    scheduledTasks: {
      list: () =>
        invokeScheduledTasksDb<ScheduledTaskListItem[]>(
          ipcRendererLike,
          ScheduledTasksIpcChannel.List
        ),
      runs: (request?: ScheduledTaskRunsRequest) =>
        invokeScheduledTasksDb<ScheduledTaskRunItem[]>(
          ipcRendererLike,
          ScheduledTasksIpcChannel.Runs,
          request
        ),
      create: (payload: ScheduledTaskSaveInput) =>
        invokeScheduledTasksDb<ScheduledTaskListItem>(
          ipcRendererLike,
          ScheduledTasksIpcChannel.Create,
          payload
        ),
      update: (payload: ScheduledTaskSaveInput) =>
        invokeScheduledTasksDb<ScheduledTaskListItem>(
          ipcRendererLike,
          ScheduledTasksIpcChannel.Update,
          payload
        ),
      delete: (id: string) =>
        invokeScheduledTasksDb<boolean>(
          ipcRendererLike,
          ScheduledTasksIpcChannel.Delete,
          id
        ),
      toggle: (id: string, enabled: boolean) =>
        invokeScheduledTasksDb<ScheduledTaskListItem | null>(
          ipcRendererLike,
          ScheduledTasksIpcChannel.Toggle,
          id,
          enabled
        ),
      runNow: (id: string) =>
        invokeScheduledTasksDb<boolean>(
          ipcRendererLike,
          ScheduledTasksIpcChannel.RunNow,
          id
        ),
      previewSchedule: (request: SchedulePreviewRequest) =>
        invokeScheduledTasksDb<SchedulePreviewResult>(
          ipcRendererLike,
          ScheduledTasksIpcChannel.PreviewSchedule,
          request
        ),
      onChanged: (callback: () => void) => {
        const handler = (() => callback()) as (...args: never[]) => void;
        ipcRendererLike.on?.(SCHEDULED_TASKS_CHANGED_CHANNEL, handler);
        return () => {
          ipcRendererLike.removeListener?.(
            SCHEDULED_TASKS_CHANGED_CHANNEL,
            handler
          );
        };
      },
    },
    updateSettings: (partial: unknown) =>
      ipcRendererLike.invoke(
        "desktop:update-settings",
        partial
      ) as Promise<unknown>,
    getRuntimeStatus: () =>
      ipcRendererLike.invoke("desktop:get-runtime-status") as Promise<unknown>,
    // FEA-2715 / ISS-4719: per-file transcript archive-lane status for the
    // availability UI (FEA-2716/2717). Mirrors the main-process handler in
    // `runtime-info-ipc.ts`; returns a disabled snapshot when the flag is off.
    getTranscriptSyncStatus: () =>
      ipcRendererLike.invoke(
        RuntimeInfoIpcChannel.GetTranscriptSyncStatus
      ) as Promise<TranscriptSyncStatusSnapshot>,
    /**
     * ISS-5477: per-lane desktop→cloud drain state + queue depths, so the
     * renderer's app-core mode can keep reading this machine's own data until
     * the cloud actually has it. Counts and states only, never content.
     */
    getCloudReadReadiness: () =>
      ipcRendererLike.invoke(
        RuntimeInfoIpcChannel.GetCloudReadReadiness
      ) as Promise<CloudReadReadinessSnapshot>,
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
    // PRD-532 (M4) → FEA-4103: legacy sync-consent tier setter, kept as a
    // backward-compat alias. The main-process handler now maps the tier to its
    // canonical DataSyncLevel and routes through the same setDataSyncLevel path,
    // so it can no longer set the tier in isolation and desync the level UI.
    setSyncObservabilityTier: (tier: string) =>
      ipcRendererLike.invoke(
        "desktop:set-sync-observability-tier",
        tier
      ) as Promise<{ tier: string }>,
    // FEA-3907: read/persist the graduated data sync level (Settings "Data &
    // Sync"). The main process derives the connectivity/sync booleans from it.
    getDataSyncLevel: () =>
      ipcRendererLike.invoke("desktop:get-data-sync-level") as Promise<{
        level: string;
      }>,
    setDataSyncLevel: (level: string) =>
      ipcRendererLike.invoke("desktop:set-data-sync-level", level) as Promise<{
        level: string;
      }>,
    // ISS-5489: read/write the post-auth sync-consent answer. The read exposes
    // the raw tier (null = never answered) because the level reconciles a
    // missing value into a real one and so cannot report "never asked".
    getSyncConsentRecord: () =>
      ipcRendererLike.invoke("desktop:get-sync-consent-record") as Promise<{
        tier: string | null;
        organizationId: string | null;
        bound: boolean;
      }>,
    recordSyncConsent: (payload: {
      level: string;
      organizationId: string | null;
    }) =>
      ipcRendererLike.invoke(
        "desktop:record-sync-consent",
        payload
      ) as Promise<{ level: string; organizationId: string | null }>,
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
      ipcRendererLike.invoke(
        "desktop:pick-sandbox-directory"
      ) as Promise<SandboxInspectResult | null>,
    inspectSandboxPath: (path: string) =>
      ipcRendererLike.invoke(
        "desktop:inspect-sandbox-path",
        path
      ) as Promise<SandboxInspectResult | null>,
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
      ) as Promise<CoachingHarnessResult>,
    installCoachingArtifact: (draft: string, harness?: string, kind?: string) =>
      ipcRendererLike.invoke(
        "desktop:agent-coaching:install",
        draft,
        harness,
        kind
      ) as Promise<CoachingHarnessResult>,
    getCoachingPack: () =>
      ipcRendererLike.invoke(
        "desktop:agent-coaching:get-pack"
      ) as Promise<unknown>,
    installCoachingPack: (sourceDir: string) =>
      ipcRendererLike.invoke(
        "desktop:agent-coaching:install-pack",
        sourceDir
      ) as Promise<unknown>,
    /**
     * Audit Bot (FEA-3847 / PRD-556 M1). `run` executes a crewd review character
     * against the open repo via the harness cascade and resolves with the parsed
     * findings; `onProgress` subscribes to the streamed cascade trail for
     * in-flight runs. The request may carry the operator-selected harness / model
     * / cascade order (FEA-4009); an omitted cascade defaults main-side to the
     * historical fixed order. Gated main-side by the `auditBot` Labs flag +
     * sender trust — a disabled/denied run resolves with a typed refusal result.
     */
    audit: {
      run: (request: AuditRunRequest) =>
        ipcRendererLike.invoke(
          AuditIpcChannel.Run,
          request
        ) as Promise<AuditRunResult>,
      // FEA-3849 (M3): file the user's SELECTED findings to ClosedLoop. Only
      // called after the user selects + confirms — never automatically. Gated
      // main-side by sender trust + the `auditBot` flag; the ClosedLoop network
      // call runs main-side (the access token never crosses this bridge).
      file: (request: AuditFileRequest) =>
        ipcRendererLike.invoke(
          AuditIpcChannel.File,
          request
        ) as Promise<AuditFileResult>,
      onProgress: (callback: (payload: AuditProgressPayload) => void) => {
        const handler = (_event: unknown, payload: AuditProgressPayload) =>
          callback(payload);
        ipcRendererLike.on?.(
          AuditIpcChannel.Progress,
          handler as (...args: never[]) => void
        );
        return () =>
          ipcRendererLike.removeListener?.(
            AuditIpcChannel.Progress,
            handler as (...args: never[]) => void
          );
      },
    },
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
    /**
     * Notify main that the renderer reached a readiness milestone. ISS-5346:
     * the phase distinguishes the pre-mount static shell from the mounted React
     * app; only the latter reveals the window. Defaults to `Shell` so an
     * untaught caller keeps the conservative pre-ISS-5346 meaning.
     */
    notifyRendererReady: (
      phase: RendererReadyPhase = RendererReadyPhase.Shell
    ) => {
      ipcRendererLike.send("desktop:renderer-ready", phase);
    },
    // First-party desktop auth (FEA-2219 / PLN-1138). Sign-in/out + identity
    // flow entirely through the main-process DesktopSessionManager. No
    // credential crosses this boundary at all: the renderer auth port surfaces
    // an opaque sentinel, and the cloudApiFetch bridge below attaches the real
    // access token in the main process. Refresh token and device-session
    // secret never leave main either.
    getDesktopAuthState: () =>
      ipcRendererLike.invoke(
        "desktop:get-desktop-auth-state"
      ) as Promise<DesktopAuthState>,
    // ISS-5112: `provider` is optional and forwarded verbatim. Main validates it
    // (an unknown value degrades to no hint), so this stays a thin pass-through.
    beginDesktopSignIn: (provider?: DesktopSignInProvider) =>
      ipcRendererLike.invoke(
        "desktop:begin-desktop-sign-in",
        provider
      ) as Promise<DesktopBrowserSignInResult>,
    cancelDesktopSignIn: () =>
      ipcRendererLike.invoke("desktop:cancel-desktop-sign-in") as Promise<void>,
    signOutDesktop: () =>
      ipcRendererLike.invoke("desktop:sign-out-desktop") as Promise<void>,
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
    // FEA-3639: re-run the boot import after the user grants a previously-denied
    // file-access permission, so the now-readable sessions backfill without an
    // app restart (the Sessions file-access prompt's Reload action).
    reimportAgentSessions: () =>
      ipcRendererLike.invoke(
        "desktop:reimport-agent-sessions"
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
