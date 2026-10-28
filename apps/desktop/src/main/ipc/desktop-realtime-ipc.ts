import type {
  Event as ElectronEvent,
  WebContents,
  WebContentsDidStartNavigationEventParams,
} from "electron";
import { desktopRealtimeChannelRequestSchema } from "../../shared/desktop-realtime-contract.js";
import { DesktopRealtimeIpcChannel } from "../../shared/desktop-realtime-ipc-channel.js";
import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import type {
  DesktopRealtimeHolder,
  DesktopRealtimeHost,
} from "../realtime/desktop-realtime-host.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";
import { sendToRendererContents } from "./renderer-ipc.js";

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: { sender: WebContents }, payload?: unknown) => unknown
  ) => void;
};

export type DesktopRealtimeIpcDeps = {
  isTrustedSender: (sender: unknown) => boolean;
  host: Pick<DesktopRealtimeHost, "join" | "leave" | "release">;
};

/**
 * PLN-2162 M4: `realtime:join` and `realtime:leave` for the renderer's port,
 * gated on sender trust like every sibling handler. A payload that fails its
 * schema is dropped. A renderer's holds are released when its `webContents`
 * is destroyed, its process goes, or its main frame starts a cross-document
 * navigation, which a reload is.
 */
export function registerDesktopRealtimeIpcHandlers(
  ipcMain: IpcMainLike,
  deps: DesktopRealtimeIpcDeps
): void {
  const tracked = new WeakSet<WebContents>();
  const holderFor = (sender: WebContents): DesktopRealtimeHolder => {
    if (!tracked.has(sender)) {
      tracked.add(sender);
      const id = sender.id;
      releaseOnTeardown(sender, () => deps.host.release(id));
    }
    return {
      id: sender.id,
      send: (event) =>
        sendToRendererContents(
          sender,
          DesktopRendererEventChannel.Realtime,
          event
        ),
    };
  };

  ipcMain.handle(DesktopRealtimeIpcChannel.Join, (event, payload) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    const request = desktopRealtimeChannelRequestSchema.safeParse(payload);
    if (!request.success) {
      return;
    }
    return deps.host.join(holderFor(event.sender), request.data.channel);
  });

  ipcMain.handle(DesktopRealtimeIpcChannel.Leave, (event, payload) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    const request = desktopRealtimeChannelRequestSchema.safeParse(payload);
    if (request.success) {
      deps.host.leave(event.sender.id, request.data.channel);
    }
  });
}

function releaseOnTeardown(sender: WebContents, release: () => void): void {
  sender.once("destroyed", release);
  sender.on("render-process-gone", release);
  sender.on(
    "did-start-navigation",
    (details: ElectronEvent<WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) {
        release();
      }
    }
  );
}
