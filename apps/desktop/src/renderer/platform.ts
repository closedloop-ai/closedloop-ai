const MAC_USER_AGENT = /Macintosh|Mac OS X/;

/**
 * macOS hosts the window with a hidden native title bar (see main/window.ts),
 * so the renderer overlays its own chrome around the stoplight buttons. Read the
 * platform exposed statically by the preload; fall back to the user-agent so the
 * check stays safe if the bridge is ever unavailable (e.g. Storybook).
 */
export function isMacOS(): boolean {
  const platform = globalThis.window?.desktopApi?.platform;
  if (platform) {
    return platform === "darwin";
  }
  return MAC_USER_AGENT.test(globalThis.navigator?.userAgent ?? "");
}

// macOS 26 (Tahoe) reworked window-control compositing: inactive windows now
// keep the custom-positioned stoplight buttons rendered (dimmed) instead of
// dropping them on blur, which is what every prior version did and what the
// stoplight underlay exists to paper over.
const FIRST_MACOS_VERSION_THAT_KEEPS_INACTIVE_BUTTONS = 26;

/**
 * Whether the muted stoplight underlay should render. It only compensates for
 * the pre-Tahoe quirk where Electron drops the native buttons on blur; on macOS
 * 26+ the dimmed buttons stay put, so drawing the underlay there just
 * double-draws and visibly misaligns. When the version is unknown (bridge
 * unavailable) we keep the historical behavior and render it.
 */
export function macStoplightUnderlayEnabled(): boolean {
  if (!isMacOS()) {
    return false;
  }
  const major = globalThis.window?.desktopApi?.macOSMajorVersion ?? null;
  return (
    major === null || major < FIRST_MACOS_VERSION_THAT_KEEPS_INACTIVE_BUTTONS
  );
}
