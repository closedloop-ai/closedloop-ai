import type { WebContents } from "electron";
import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import { RendererLifecycleIpcChannel } from "../../shared/renderer-lifecycle-ipc-channel.js";
import {
  RendererReadyPhase,
  toRendererReadyPhase,
} from "../../shared/renderer-ready-phase.js";

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
  /**
   * `DesktopWindow.sendToRenderer`: never throws, pre-checks a disposed render
   * frame, and logs the channel it drops. The trust gate has already pinned
   * the sender to that window's `webContents`.
   */
  sendToRenderer: (channel: string, ...args: unknown[]) => boolean;
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
      if (!deps.isTrustedSender(event.sender)) {
        return;
      }
      const readyPhase = toRendererReadyPhase(phase);
      deps.handleRendererReady(event.sender, readyPhase);
      if (readyPhase === RendererReadyPhase.NavigationReady) {
        return;
      }
      // Fire-and-forget: ipcMain.on ignores the returned promise. Yield first so
      // the ready ack lands after the current main-loop turn drains.
      await deps.yieldToMainLoop();
      if (
        deps.isShuttingDown() ||
        event.sender.isDestroyed() ||
        !deps.isTrustedSender(event.sender)
      ) {
        return;
      }
      if (!deps.isLocalSessionSourceReady()) {
        return;
      }
      // ISS-9175: a render frame disposed during the yield makes a bare
      // `event.sender.send` throw while `isDestroyed()` still reports false,
      // and nothing awaits this listener. The guarded helper drops and logs
      // instead; the renderer's next refresh re-sends renderer-ready.
      deps.sendToRenderer(DesktopRendererEventChannel.DbReady, {});
      deps.sendToRenderer(DesktopRendererEventChannel.DbChanged, {});
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
