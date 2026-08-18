import type { AgentMonitorRuntimeStatus } from "../../shared/agent-monitor-status.js";
import type { CloudReadReadinessSnapshot } from "../../shared/cloud-read-readiness-contract.js";
import type { ConnectionSecurityStatus } from "../../shared/connection-security.js";
import { FEATURE_FLAGS } from "../../shared/feature-flags.js";
import type { AgentSessionSyncProgress } from "../agent-sync/agent-session-sync-service-options.js";
import type { CloudSocketStatus } from "../cloud/cloud-protocol.js";
import type { FileAccessBlock } from "../collectors/engine/file-access-probe.js";
import type { AuthorizedCommandKeyStore } from "../command-signing/authorized-command-key-store.js";
import type { AgentDashboardDesignSystemRuntime } from "../dashboard/agent-dashboard-design-system-runtime.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { TranscriptSyncStatusSnapshot } from "../transcript-sync/transcript-sync-options.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export const RuntimeInfoIpcChannel = {
  GetAppVersion: "desktop:get-app-version",
  GetAllFlags: "desktop:get-all-flags",
  GetTranscriptSyncStatus: "desktop:get-transcript-sync-status",
  GetRuntimeStatus: "desktop:get-runtime-status",
  /**
   * ISS-5477: whether the desktop→cloud backlog has drained far enough for the
   * renderer to move its read source to the cloud. A separate channel from
   * `GetRuntimeStatus` because it is polled on its own (much shorter) cadence
   * while the reader waits, and stops entirely once the cutover latches.
   */
  GetCloudReadReadiness: "desktop:get-cloud-read-readiness",
} as const;

export type RuntimeInfoIpcChannel =
  (typeof RuntimeInfoIpcChannel)[keyof typeof RuntimeInfoIpcChannel];

type IngestProgress = ReturnType<
  AgentDashboardDesignSystemRuntime["getIngestProgress"]
>;
type MaintenanceProgress = ReturnType<
  AgentDashboardDesignSystemRuntime["getMaintenanceProgress"]
>;

type IpcMainLike = {
  handle: (
    channel: RuntimeInfoIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

// Exported so the sender-gate behavioral test (`test/ipc-sender-gates.test.ts`)
// can construct the deps and drive untrusted events through the real handler.
export type RuntimeInfoIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  // Injected (rather than importing `electron`) so this registrar carries no
  // module-scope electron dependency and stays loadable under `test:node`.
  getAppVersion: () => string;
  getIsPackaged: () => boolean;
  settingsStore: SettingsStore;
  authorizedCommandKeys: AuthorizedCommandKeyStore;
  getTranscriptSyncStatus: () => Promise<TranscriptSyncStatusSnapshot>;
  getActivePort: () => number;
  getCloudStatus: () => CloudSocketStatus;
  getCloudCommandsPaused: () => boolean;
  getCloudConnectionEnabled: () => boolean;
  getConnectionSecurityStatus: () => ConnectionSecurityStatus;
  getServerCommandSigningSupported: () => boolean;
  isServerAlive: () => boolean;
  getGatewayHealthy: () => boolean;
  getIngestProgress: () => IngestProgress | null;
  getFileAccessBlocks: () => FileAccessBlock[];
  getMaintenanceProgress: () => MaintenanceProgress | null;
  getCloudSyncProgress: () => AgentSessionSyncProgress;
  getDashboardReady: () => boolean;
  // ISS-4714: the first-class Agent Monitor runtime status. Drives the renderer
  // "update required — your data is newer than this app" degraded state when the
  // local DB is ahead of the app build, so the UI never pretends sync is healthy.
  getAgentMonitorStatus: () => AgentMonitorRuntimeStatus;
  /**
   * ISS-5477: the burn-down-backed readiness the renderer's read-source gate
   * reads. Returns an UNKNOWN snapshot (never a drained one) whenever the
   * burn-down has no sample to report.
   */
  getCloudReadReadiness: () => CloudReadReadinessSnapshot;
};

export function registerRuntimeInfoIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: RuntimeInfoIpcDeps
): void {
  ipcMainLike.handle(RuntimeInfoIpcChannel.GetAppVersion, () =>
    deps.getAppVersion()
  );
  ipcMainLike.handle(RuntimeInfoIpcChannel.GetAllFlags, () => ({
    registry: FEATURE_FLAGS,
    flags: deps.settingsStore.getAllFlags(),
  }));
  // FEA-2715: per-file transcript archive-lane status for the availability UI
  // (FEA-2716/2717). Returns a disabled snapshot when the flag is off.
  ipcMainLike.handle(RuntimeInfoIpcChannel.GetTranscriptSyncStatus, (event) => {
    // Status includes per-file paths/errors — restrict to the trusted renderer.
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return deps.getTranscriptSyncStatus();
  });
  ipcMainLike.handle(RuntimeInfoIpcChannel.GetRuntimeStatus, (event) => {
    // FEA-3639: the payload now carries `fileAccessBlocks[].path` (harness
    // transcript roots), so restrict it to the trusted renderer like the
    // per-file-path `GetTranscriptSyncStatus` sibling above.
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return {
      port: deps.getActivePort(),
      cloudStatus: deps.getCloudStatus(),
      relayOrigin: deps.settingsStore.getRelayOrigin(),
      apiOrigin: deps.settingsStore.getApiOrigin(),
      sandboxBaseDirectory: deps.settingsStore.getSandboxBaseDirectory(),
      commandsPaused: deps.getCloudCommandsPaused(),
      connectionEnabled: deps.getCloudConnectionEnabled(),
      connectionSecurity: deps.getConnectionSecurityStatus(),
      commandSigning: {
        serverSupported: deps.getServerCommandSigningSupported(),
        enforcementEnabled:
          deps.settingsStore.getCommandSigningEnforcementEnabled(),
        authorizedKeyCount: deps.authorizedCommandKeys.list().length,
      },
      serverAlive: deps.isServerAlive(),
      gatewayHealthy: deps.getGatewayHealthy(),
      // Per-harness first-pass ingest progress for the dashboard FTUE loading
      // treatment (null until the Agent Dashboard runtime is up).
      ingest: deps.getIngestProgress(),
      // FEA-3639: harness transcript roots the OS won't let us read (a denied
      // macOS file-access prompt), so the Sessions view can say so explicitly
      // instead of stalling silently. Empty array = nothing blocked.
      fileAccessBlocks: deps.getFileAccessBlocks(),
      // FEA-2264: the live post-boot maintenance phase (data-revision rebuild +
      // artifact-link backfill). The first-launch banner keeps a calm "finishing
      // up" state visible across this window — the residual freeze the user hit
      // after the boot import settles but before the dashboard is fully ready.
      maintenance: deps.getMaintenanceProgress(),
      // FEA-2733: content-blind local→cloud sync progress for the renderer
      // "syncing your history" indicator (counts only, no ids/content). Drives
      // the History Sync status in Settings → Connection Status.
      cloudSync: deps.getCloudSyncProgress(),
      // ISS-5768: the WHOLE-APP backlog, on the same 1s cadence the indicator
      // already polls. `cloudSync.caughtUp` above is the session lane alone, so
      // an indicator built on it claimed "Up to date" while the component
      // inventory still owed thousands of rows. Same counts-only projection the
      // read-source gate reads via `GetCloudReadReadiness`, and the same
      // in-memory read of the last burn-down sample (sampled once a minute), so
      // adding it here costs a field copy, not a measurement.
      cloudReadReadiness: deps.getCloudReadReadiness(),
      // Whether the initial collector import has completed, so the sidebar can
      // show the Dashboard nav item as "still preparing" (throbber) until the
      // local-first analytics are ready, then surface a "ready" call-to-action.
      dashboardReady: deps.getDashboardReady(),
      // ISS-4714: the first-class Agent Monitor runtime status. `agentMonitor.
      // dbAhead` is true only when the local DB was created by a newer Desktop
      // build, so the renderer can show a prominent "update required" state
      // instead of silently running with dead local sync.
      agentMonitor: deps.getAgentMonitorStatus(),
      // Authoritative dev-vs-release signal for the renderer's feature-flag
      // adapter (apps/desktop/src/renderer/feature-flags). The renderer bundle
      // is identical packaged vs unpackaged, so this must come from the main
      // process — `import.meta.env` cannot distinguish them.
      isPackaged: deps.getIsPackaged(),
    };
  });
  // ISS-5477: per-lane drain state + queue depths only — counts, never content.
  // Sender-gated like its siblings: the payload describes how far behind this
  // machine's account is, which is not something an untrusted frame may sample.
  ipcMainLike.handle(RuntimeInfoIpcChannel.GetCloudReadReadiness, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return deps.getCloudReadReadiness();
  });
}
