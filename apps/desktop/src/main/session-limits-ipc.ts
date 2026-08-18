/**
 * @file session-limits-ipc.ts
 * @description Registers the desktop IPC handlers for the subscription
 * session-limit surface: serving the snapshot to the renderer (PRD-538) by
 * reconciling the snapshots recorded by the `usage_api` / statusline /
 * rate_limit_event producers (FEA-3493, PRD-538 R5) — and toggling the
 * statusline-capture opt-in that populates one of them (FEA-3492 / PRD-539).
 * Untrusted senders and every fetch failure resolve to null so the renderer
 * simply hides the UI.
 */
import {
  SessionLimitsIpcChannel,
  type SessionLimitsSnapshot,
  type StatuslineCaptureResult,
} from "../shared/session-limits-channel.js";
import { assertTrustedIpcSender } from "./ipc/ipc-trusted-sender.js";
import {
  type SessionLimitsSnapshotStore,
  sessionLimitsSnapshotStore,
} from "./session-limits/snapshot-store.js";

// The statusline-capture module reaches into `electron` (app paths, electron-store)
// at import time. It is loaded lazily inside the statusline handlers so that the
// snapshot `Get` handler — and its Node-only tests — can register without pulling
// Electron into module scope. Runtime behavior is unchanged: the toggle handlers
// still resolve the real implementation on first invocation.

type IpcMainLike = {
  handle: (
    channel: SessionLimitsIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

export type SessionLimitsIpcDeps = {
  isTrustedSender: (sender: unknown) => boolean;
  /** Golden mode never mutates the real Claude `statusLine` config. */
  isGoldenMode: () => boolean;
  /** Snapshot store to reconcile (defaults to the process-wide instance). */
  snapshotStore?: SessionLimitsSnapshotStore;
  /** Current epoch ms, injectable for tests (defaults to `Date.now`). */
  now?: () => number;
};

/** Register the session-limit snapshot + statusline-capture toggle handlers. */
export function registerSessionLimitsIpcHandlers(
  ipcMain: IpcMainLike,
  deps: SessionLimitsIpcDeps
): void {
  const snapshotStore = deps.snapshotStore ?? sessionLimitsSnapshotStore;
  const now = deps.now ?? Date.now;
  ipcMain.handle(
    SessionLimitsIpcChannel.Get,
    (event): Promise<SessionLimitsSnapshot | null> => {
      const sender =
        event && typeof event === "object"
          ? (event as { sender?: unknown }).sender
          : undefined;
      if (!deps.isTrustedSender(sender)) {
        return Promise.resolve(null);
      }
      // Serve the reconciled producer snapshot. The `/usage` producer
      // (PRD-538 R5) keeps the store warm on its own schedule, so this handler
      // never performs a credential read or a network call itself. Any resolver
      // failure degrades to null, upholding the "every failure resolves to null
      // so the renderer hides the UI" contract.
      try {
        return Promise.resolve(snapshotStore.resolve(now()));
      } catch {
        return Promise.resolve(null);
      }
    }
  );

  ipcMain.handle(
    SessionLimitsIpcChannel.GetStatuslineCaptureEnabled,
    async (event) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const { isStatuslineCaptureEnabled } = await import(
        "./session-limits/statusline-capture-install.js"
      );
      return isStatuslineCaptureEnabled();
    }
  );

  ipcMain.handle(
    SessionLimitsIpcChannel.SetStatuslineCaptureEnabled,
    async (event, enabled): Promise<StatuslineCaptureResult> => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      if (deps.isGoldenMode()) {
        return {
          ok: false,
          enabled: false,
          error: "Golden mode: statusline capture is disabled.",
        };
      }
      const { setStatuslineCaptureEnabled } = await import(
        "./session-limits/statusline-capture-install.js"
      );
      return setStatuslineCaptureEnabled(enabled === true);
    }
  );
}
