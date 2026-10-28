/**
 * Development-only transport contract for mirroring the trusted Electron
 * preload API into a browser renderer. This module stays plain ESM so both the
 * Node dev launcher and the Vite renderer can consume one set of event names.
 */

export const desktopBrowserBridgeEvent = Object.freeze({
  callback: "desktop-browser-bridge:callback",
  clientDisconnected: "desktop-browser-bridge:client-disconnected",
  hostDisconnected: "desktop-browser-bridge:host-disconnected",
  manifest: "desktop-browser-bridge:manifest",
  request: "desktop-browser-bridge:request",
  response: "desktop-browser-bridge:response",
});

export const desktopBrowserBridgeRole = Object.freeze({
  Client: "client",
  Host: "host",
});

/**
 * Why a request failed, carried on the response alongside the message so the
 * caller can tell a size refusal from a dead host from a genuine timeout. A
 * peer that predates this field omits it; treat an absent reason as unknown
 * rather than as any particular failure.
 */
export const desktopBrowserBridgeErrorReason = Object.freeze({
  HostDisconnected: "host-disconnected",
  HostError: "host-error",
  HostUnavailable: "host-unavailable",
  InvalidRequest: "invalid-request",
  PayloadTooLarge: "payload-too-large",
  SocketDisconnected: "socket-disconnected",
  Timeout: "timeout",
  Unknown: "unknown",
});

/**
 * The RESPONSE direction's size refusal, emitted by the HOST before it puts an
 * over-size response on the wire and by the BROKER for a peer host that does
 * not. One constant because a caller matching on the text must see the same
 * sentence whichever end refused it. The request direction has its own sentence
 * ({@link desktopBrowserBridgeRequestTooLargeMessage}), because the two name
 * different payloads and only one of them is the caller's to shrink.
 */
export const desktopBrowserBridgePayloadTooLargeMessage =
  "Desktop browser bridge response exceeds the size limit";

export const desktopBrowserBridgePath = "/closedloop-desktop-browser-bridge";

/**
 * Query parameter each entry document carries its OWN role's launch token in.
 *
 * The token deliberately does NOT travel as a Vite env value: `import.meta.env`
 * is inlined into the transformed module the dev server hands to anyone who asks
 * for it, so any local process could read the credential out of the served
 * source and connect without user interaction. A query parameter is only known
 * to whoever received the URL. It is not a fragment because the desktop renderer
 * persists its route in `location.hash`, which would clobber the token and
 * mis-parse it as a route.
 *
 * The two roles reach that parameter by different routes. The CLIENT token
 * rides the URL the launcher prints for the operator. The HOST token does NOT:
 * ISS-8412 took it off the `--closedloop-renderer-url=` argument, so it now
 * travels to Electron in {@link desktopBrowserBridgeHostTokenEnvVar} and the
 * main process appends it to the URL it loads in-process.
 */
export const desktopBrowserBridgeTokenParam = "closedloopBridgeToken";

/**
 * Environment variable the launcher hands the HOST launch token to Electron in.
 *
 * NOT argv (ISS-8412). Process arguments are world-readable on macOS and Linux —
 * `ps -ef` is enough, from any user — so a renderer URL carrying the host token
 * published a credential that mints an authorized bridge host to every local
 * process. An environment variable is readable only by the same user (plus root,
 * plus a debugger), and the main process removes it from `process.env` before
 * anything it spawns can inherit it.
 */
export const desktopBrowserBridgeHostTokenEnvVar =
  "CLOSEDLOOP_DESKTOP_BROWSER_BRIDGE_HOST_TOKEN";

/** 256 bits of `base64url`, which is what a minted launch token is. */
export const desktopBrowserBridgeMinimumTokenLength = 43;

/**
 * How long the broker keeps admitting the host token once no host holds the
 * bridge (ISS-8412). The window opens on the host's disconnect and is closed
 * again by the next successful host admission, so a live session never expires
 * mid-flight and a socket drop or renderer reload — both of which reconnect in
 * seconds — always lands inside it. A token that outlives the session it was
 * minted for stops admitting anything five minutes after the host goes away;
 * recovering from that is a relaunch, which mints a new pair.
 */
export const desktopBrowserBridgeHostRejoinWindowMs = 5 * 60 * 1000;

/** Why the broker refused a host handshake after its rejoin window elapsed. */
export const desktopBrowserBridgeHostExpiredMessage =
  "Desktop browser bridge host token has expired; relaunch the bridge";

/**
 * The REQUEST direction's size refusal (ISS-8413), emitted by the CLIENT before
 * it puts an over-size request on the wire and by the BROKER for a peer client
 * that does not.
 */
export const desktopBrowserBridgeRequestTooLargeMessage =
  "Desktop browser bridge request exceeds the size limit";

/**
 * The REQUEST direction's shape refusal (ISS-8413). Distinct from the size one
 * because the caller's remedy differs: a shape it must correct rather than a
 * payload it must split.
 */
export const desktopBrowserBridgeInvalidRequestMessage =
  "Desktop browser bridge request is invalid";
