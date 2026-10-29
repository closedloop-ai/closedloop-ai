export const desktopBrowserBridgeEvent: Readonly<{
  callback: "desktop-browser-bridge:callback";
  clientDisconnected: "desktop-browser-bridge:client-disconnected";
  hostDisconnected: "desktop-browser-bridge:host-disconnected";
  manifest: "desktop-browser-bridge:manifest";
  request: "desktop-browser-bridge:request";
  response: "desktop-browser-bridge:response";
}>;

export const desktopBrowserBridgeRole: Readonly<{
  Client: "client";
  Host: "host";
}>;

export const desktopBrowserBridgeErrorReason: Readonly<{
  HostDisconnected: "host-disconnected";
  HostError: "host-error";
  HostUnavailable: "host-unavailable";
  InvalidRequest: "invalid-request";
  PayloadTooLarge: "payload-too-large";
  SocketDisconnected: "socket-disconnected";
  Timeout: "timeout";
  Unknown: "unknown";
}>;

export type DesktopBrowserBridgeErrorReason =
  (typeof desktopBrowserBridgeErrorReason)[keyof typeof desktopBrowserBridgeErrorReason];

export const desktopBrowserBridgePayloadTooLargeMessage: "Desktop browser bridge response exceeds the size limit";

export const desktopBrowserBridgeRequestTooLargeMessage: "Desktop browser bridge request exceeds the size limit";

export const desktopBrowserBridgeInvalidRequestMessage: "Desktop browser bridge request is invalid";

export const desktopBrowserBridgePath: "/closedloop-desktop-browser-bridge";

export const desktopBrowserBridgeTokenParam: "closedloopBridgeToken";

export const desktopBrowserBridgeHostTokenEnvVar: "CLOSEDLOOP_DESKTOP_BROWSER_BRIDGE_HOST_TOKEN";

export const desktopBrowserBridgeMinimumTokenLength: 43;

export const desktopBrowserBridgeHostRejoinWindowMs: number;

export const desktopBrowserBridgeHostExpiredMessage: "Desktop browser bridge host token has expired; relaunch the bridge";

export type DesktopBrowserBridgeRole =
  (typeof desktopBrowserBridgeRole)[keyof typeof desktopBrowserBridgeRole];
