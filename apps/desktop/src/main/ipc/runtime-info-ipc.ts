import type { AgentMonitorRuntimeStatus } from "../../shared/agent-monitor-status.js";
import type { CloudReadReadinessSnapshot } from "../../shared/cloud-read-readiness-contract.js";
import type { ConnectionSecurityStatus } from "../../shared/connection-security.js";
import { FEATURE_FLAGS } from "../../shared/feature-flags.js";
import { RuntimeInfoIpcChannel } from "../../shared/runtime-info-ipc-channel.js";
import type { AgentSessionSyncProgress } from "../agent-sync/agent-session-sync-service-options.js";
import type { ComputeTargetLinkBlockState } from "../agent-sync/compute-target-link-block.js";
import type { CloudSocketStatus } from "../cloud/cloud-protocol.js";
import type { FileAccessBlock } from "../collectors/engine/file-access-probe.js";
import type { AgentDashboardDesignSystemRuntime } from "../dashboard/agent-dashboard-design-system-runtime.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { TranscriptSyncStatusSnapshot } from "../transcript-sync/transcript-sync-options.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

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
  /**
   * ISS-8776 — is there no live renderer window left to verify against?
   *
   * Consulted only to LABEL a refusal `isTrustedSender` has already made, never
   * to grant one. Wired on this registrar in particular because
   * `desktop:get-runtime-status` is the health channel the renderer polls once a
   * second: during a fatal `app.exit()` teardown every poll in flight was
   * refused, and reporting those as `untrusted sender` made the app's own
   * renderer look like an attacker in the crash log. Optional so an existing
   * caller or test that does not wire it keeps today's behavior exactly.
   */
  isRendererWindowGone?: () => boolean;
  // Injected (rather than importing `electron`) so this registrar carries no
  // module-scope electron dependency and stays loadable under `test:node`.
  getAppVersion: () => string;
  getIsPackaged: () => boolean;
  settingsStore: SettingsStore;
  getTranscriptSyncStatus: () => Promise<TranscriptSyncStatusSnapshot>;
  getActivePort: () => number;
  getCloudStatus: () => CloudSocketStatus;
  getCloudCommandsPaused: () => boolean;
  getCloudConnectionEnabled: () => boolean;
  getConnectionSecurityStatus: () => ConnectionSecurityStatus;
  isServerAlive: () => boolean;
  getGatewayHealthy: () => boolean;
  getIngestProgress: () => IngestProgress | null;
  getFileAccessBlocks: () => FileAccessBlock[];
  getMaintenanceProgress: () => MaintenanceProgress | null;
  getCloudSyncProgress: () => AgentSessionSyncProgress;
  /**
   * ISS-11426: the compute-target link block, or null when nothing is blocked.
   * Optional so a caller that predates it — the harness and several test
   * builders — keeps working and the field degrades to absent.
   */
  getComputeTargetLinkBlock?: () => ComputeTargetLinkBlockState | null;
  getDashboardReady: () => boolean;
  // ISS-4714: the first-class Agent Monitor runtime status. Drives the renderer
  // "update required — your data is newer than this app" degraded state when the
  // local DB is ahead of the app build, so the UI never pretends sync is healthy.
  getAgentMonitorStatus: () => AgentMonitorRuntimeStatus;
  /**
   * The burn-down-backed readiness the Settings → History Sync cell and the
   * startup panel read. Returns an UNKNOWN snapshot (never a drained one)
   * whenever the burn-down has no sample to report.
   */
  getCloudReadReadiness: () => CloudReadReadinessSnapshot;
  /**
   * ISS-11838: the install's `node_uuid`, which the renderer's session-replay
   * client sends as its distinct id. Undefined before the composition root
   * publishes it; the renderer then does not record.
   */
  getNodeUuid: () => string | undefined;
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
    //
    // ISS-8776: the third argument only LABELS a refusal already decided by
    // `isTrustedSender`. This channel is polled once a second, so during a
    // fatal `app.exit()` teardown every in-flight poll is refused with no
    // window left to verify against — reported as `untrusted sender`, that read
    // as an attack on the app's own renderer. It is a teardown, and it says so.
    assertTrustedIpcSender(
      deps.isTrustedSender,
      event,
      deps.isRendererWindowGone
    );
    return {
      port: deps.getActivePort(),
      cloudStatus: deps.getCloudStatus(),
      relayOrigin: deps.settingsStore.getRelayOrigin(),
      apiOrigin: deps.settingsStore.getApiOrigin(),
      sandboxBaseDirectory: deps.settingsStore.getSandboxBaseDirectory(),
      commandsPaused: deps.getCloudCommandsPaused(),
      connectionEnabled: deps.getCloudConnectionEnabled(),
      connectionSecurity: deps.getConnectionSecurityStatus(),
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
      // ISS-11426: the block object ONLY while the cloud is refusing this
      // machine's compute target as not owned by the signed-in account, and
      // `null` the rest of the time — including when the main process predates
      // the getter. The key is always sent; `null` is the "nothing is blocked"
      // value, and the renderer's Zod projection answers a missing or
      // unreadable value the same way (tamsinb).
      computeTargetLinkBlock: deps.getComputeTargetLinkBlock?.() ?? null,
      // ISS-5768: the WHOLE-APP backlog, on the same 1s cadence the indicator
      // already polls. `cloudSync.caughtUp` above is the session lane alone, so
      // an indicator built on it claimed "Up to date" while the component
      // inventory still owed thousands of rows. A counts-only in-memory read of
      // the last burn-down sample (sampled once a minute), so adding it here
      // costs a field copy, not a measurement.
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
      nodeUuid: deps.getNodeUuid(),
    };
  });
}
