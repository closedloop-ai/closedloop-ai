/**
 * Renderer-visible reasons why a packaged update cannot currently install.
 * Keep this pure shared contract additive because it crosses main/preload and
 * renderer boundaries.
 */
export const PackagedUpdateInstallBlockedReason = {
  ReadOnlyVolume: "read-only-volume",
} as const;

export type PackagedUpdateInstallBlockedReason =
  (typeof PackagedUpdateInstallBlockedReason)[keyof typeof PackagedUpdateInstallBlockedReason];

export const PACKAGED_UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE =
  "Updates are paused — Move Closedloop to the Applications folder to turn on automatic updates.";
