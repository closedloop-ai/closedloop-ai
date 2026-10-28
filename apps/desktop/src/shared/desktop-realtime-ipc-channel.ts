/**
 * PLN-2162 M4: the renderer's realtime port joins and leaves channels on the
 * one socket the main process holds. Events come back on
 * `DesktopRendererEventChannel.Realtime`.
 */
export const DesktopRealtimeIpcChannel = {
  Join: "desktop:realtime:join",
  Leave: "desktop:realtime:leave",
} as const;

export type DesktopRealtimeIpcChannel =
  (typeof DesktopRealtimeIpcChannel)[keyof typeof DesktopRealtimeIpcChannel];
