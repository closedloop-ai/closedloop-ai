import type { WebContents } from "electron";
import {
  type RendererReadyPhase,
  toRendererReadyPhase,
} from "../../shared/renderer-ready-phase.js";

/**
 * Renderer lifecycle signals (fire-and-forget `ipcMain.on`, not request/response):
 * the renderer announcing it is ready, going idle on the live DB, or receiving
 * user input. These drive main-process window/DB-ready glue rather than returning
 * data, so they live apart from the `desktop:*` `.handle` data domains.
 */
export const RendererLifecycleIpcChannel = {
  RendererReady: "desktop:renderer-ready",
  RendererLiveDbIdle: "desktop:renderer-live-db-idle",
  RendererUserInput: "desktop:renderer-user-input",
} as const;

export type RendererLifecycleIpcChannel =
  (typeof RendererLifecycleIpcChannel)[keyof typeof RendererLifecycleIpcChannel];

type IpcMainLike = {
  on: (
    channel: RendererLifecycleIpcChannel,
    listener: (event: { sender: WebContents }, ...args: unknown[]) => void
  ) => void;
};

type RendererLifecycleIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: WebContents) => boolean;
  /**
   * ISS-5346: `phase` distinguishes the pre-mount `index.html` shell from the
   * mounted React app. An absent/unknown phase narrows to `Shell`.
   */
  handleRendererReady: (sender: WebContents, phase: RendererReadyPhase) => void;
  yieldToMainLoop: () => Promise<void>;
  isShuttingDown: () => boolean;
  isLocalSessionSourceReady: () => boolean;
  notifyInitialRendererLiveDbIdle: () => void;
  notifyRendererUserInput: () => void;
};

export function registerRendererLifecycleIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: RendererLifecycleIpcDeps
): void {
  ipcMainLike.on(
    RendererLifecycleIpcChannel.RendererReady,
    async (event, phase) => {
      deps.handleRendererReady(event.sender, toRendererReadyPhase(phase));
      // Fire-and-forget: ipcMain.on ignores the returned promise. Yield first so
      // the ready ack lands after the current main-loop turn drains.
      await deps.yieldToMainLoop();
      if (deps.isShuttingDown() || event.sender.isDestroyed()) {
        return;
      }
      if (deps.isLocalSessionSourceReady()) {
        event.sender.send("desktop:db:ready", {});
        event.sender.send("desktop:db:changed", {});
      }
    }
  );
  ipcMainLike.on(RendererLifecycleIpcChannel.RendererLiveDbIdle, (event) => {
    if (!deps.isTrustedSender(event.sender)) {
      return;
    }
    deps.notifyInitialRendererLiveDbIdle();
  });
  ipcMainLike.on(RendererLifecycleIpcChannel.RendererUserInput, (event) => {
    if (!deps.isTrustedSender(event.sender)) {
      return;
    }
    deps.notifyRendererUserInput();
  });
}
