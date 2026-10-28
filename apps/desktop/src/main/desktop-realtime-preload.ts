import type { DesktopRealtimeApi } from "../shared/desktop-realtime-contract.js";
import { DesktopRealtimeIpcChannel } from "../shared/desktop-realtime-ipc-channel.js";
import { DesktopRendererEventChannel } from "../shared/desktop-renderer-event-channel.js";

type IpcRendererLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on?: (channel: string, listener: (...args: never[]) => void) => void;
  removeListener?: (
    channel: string,
    listener: (...args: never[]) => void
  ) => void;
};

/**
 * PLN-2162 M4: `desktopApi.realtime`, a pass-through to main's realtime host.
 * The renderer's port validates what comes back.
 */
export function createRealtimeDesktopApi(ipcRendererLike: IpcRendererLike): {
  realtime: DesktopRealtimeApi;
} {
  return {
    realtime: {
      join: (request) =>
        ipcRendererLike.invoke(DesktopRealtimeIpcChannel.Join, request),
      leave: (request) =>
        ipcRendererLike.invoke(DesktopRealtimeIpcChannel.Leave, request),
      onEvent: (callback) => {
        const handler = ((_event: unknown, payload: unknown) =>
          callback(payload)) as (...args: never[]) => void;
        ipcRendererLike.on?.(DesktopRendererEventChannel.Realtime, handler);
        return () => {
          ipcRendererLike.removeListener?.(
            DesktopRendererEventChannel.Realtime,
            handler
          );
        };
      },
    },
  };
}
