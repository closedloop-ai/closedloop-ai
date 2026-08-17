import type { AgentMonitorHooksResult } from "../../shared/contracts.js";
import type { LocalSessionSourceStatus } from "../../shared/local-session-source-status.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export const AgentMonitorIpcChannel = {
  GetAgentMonitorUrl: "desktop:get-agent-monitor-url",
  GetAgentMonitorIngestProgress: "desktop:get-agent-monitor-ingest-progress",
  SetAgentMonitorImportPaused: "desktop:set-agent-monitor-import-paused",
  // FEA-3639: re-run the idempotent boot import after the user grants a
  // previously-denied file-access permission, so the now-readable sessions
  // backfill without an app restart.
  ReimportAgentSessions: "desktop:reimport-agent-sessions",
  ReprocessAgentLogs: "desktop:reprocess-agent-logs",
  OpenAgentMonitor: "desktop:open-agent-monitor",
  GetAgentMonitorHooksEnabled: "desktop:get-agent-monitor-hooks-enabled",
  SetAgentMonitorHooksEnabled: "desktop:set-agent-monitor-hooks-enabled",
} as const;

export type AgentMonitorIpcChannel =
  (typeof AgentMonitorIpcChannel)[keyof typeof AgentMonitorIpcChannel];

type IpcMainLike = {
  handle: (
    channel: AgentMonitorIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

// Exported so the sender-gate behavioral test (`test/ipc-sender-gates.test.ts`)
// can construct the deps and drive untrusted events through the real handlers.
export type AgentMonitorIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  getAgentMonitorUrl: () => string | null;
  isAgentMonitorReady: () => boolean;
  isPlanExtractionEnabled: () => boolean;
  getLocalSessionSourceStatus: () => LocalSessionSourceStatus;
  setImportPaused: (paused: boolean) => void;
  // Returns the restart promise so the ReimportAgentSessions handler can await
  // it end-to-end (the renderer's Reload button then sees completion/failure
  // instead of the IPC resolving before the restart finishes).
  restartCollectors: () => void | Promise<void>;
  openClaudeDashboard: () => void;
  // Injected (rather than imported) so this registrar carries no module-scope
  // `electron`/`electron-store` dependency and stays loadable under `test:node`.
  isHooksEnabled: () => boolean;
  setHooksEnabled: (enabled: boolean) => AgentMonitorHooksResult;
  isGoldenMode: () => boolean;
};

export function registerAgentMonitorIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: AgentMonitorIpcDeps
): void {
  ipcMainLike.handle(AgentMonitorIpcChannel.GetAgentMonitorUrl, () => ({
    url: deps.getAgentMonitorUrl(),
    ready: deps.isAgentMonitorReady(),
    planExtractionEnabled: deps.isPlanExtractionEnabled(),
    localSessionSourceStatus: deps.getLocalSessionSourceStatus(),
  }));
  ipcMainLike.handle(
    AgentMonitorIpcChannel.GetAgentMonitorIngestProgress,
    () => null
  );
  ipcMainLike.handle(
    AgentMonitorIpcChannel.SetAgentMonitorImportPaused,
    (event, paused) => {
      // Gate on sender trust like the other desktop:* handlers so a compromised
      // or untrusted frame cannot stall the historical import/backfill.
      assertTrustedIpcSender(deps.isTrustedSender, event);
      deps.setImportPaused(paused === true);
    }
  );
  ipcMainLike.handle(AgentMonitorIpcChannel.ReimportAgentSessions, (event) => {
    // Gate on sender trust like the other mutating desktop:* handlers so an
    // untrusted frame cannot trigger a full collector restart. Boot import is
    // idempotent, so the restart is safe to invoke on demand (FEA-3639).
    assertTrustedIpcSender(deps.isTrustedSender, event);
    // Return the restart promise so `invoke` resolves only once the restart has
    // actually run — the renderer's Reload button relies on that to clear its
    // spinner and surface a failure, and to serialize overlapping clicks.
    return deps.restartCollectors();
  });
  ipcMainLike.handle(AgentMonitorIpcChannel.ReprocessAgentLogs, () => ({
    ok: false,
    error: "Reprocessing is not available for the SQLite dashboard.",
  }));
  ipcMainLike.handle(AgentMonitorIpcChannel.OpenAgentMonitor, () =>
    deps.openClaudeDashboard()
  );
  ipcMainLike.handle(AgentMonitorIpcChannel.GetAgentMonitorHooksEnabled, () =>
    deps.isHooksEnabled()
  );
  ipcMainLike.handle(
    AgentMonitorIpcChannel.SetAgentMonitorHooksEnabled,
    (event, enabled) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (deps.isGoldenMode()) {
        // FEA-2648: golden mode never touches the real hook config.
        return {
          ok: false,
          enabled: false,
          error: "Golden mode: live-capture hooks are disabled.",
        };
      }
      const result = deps.setHooksEnabled(enabled === true);
      if (result.ok) {
        // Hooks own live Claude capture, so toggling them must re-evaluate
        // the Claude file-watcher gating (`getActiveCollectionMode`): hooks-on ⇒
        // no Claude watcher (avoid double-counting turns), hooks-off ⇒ Claude
        // watcher resumes live capture. Restart the collectors so the frozen
        // boot-time decision is recomputed; boot import is idempotent, so the
        // restart is safe. (AGENTS.md: toggles must update in-memory side
        // effects together — no one-way restart guards.) Fire-and-forget here:
        // the toggle response returns the hooks result, not the restart status.
        // Wrap so a rejected restart can't surface as an unhandled rejection.
        Promise.resolve(deps.restartCollectors()).catch(() => undefined);
      }
      return result;
    }
  );
}
