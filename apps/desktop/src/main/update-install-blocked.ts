import { PACKAGED_UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE } from "../shared/packaged-update-install-blocked-reason.js";

/**
 * Pure helpers for auto-update failures where the app cannot self-update
 * because it runs from a read-only location (FEA-2349).
 *
 * Background: macOS Gatekeeper App Translocation runs a quarantined app from a
 * randomized read-only mount when it is launched from where it was downloaded
 * (~/Downloads or a mounted DMG) instead of being moved to /Applications via
 * Finder. Squirrel.Mac then cannot stage a downloaded update ("Cannot update
 * while running on a read-only volume"). That staging failure rejected the
 * updater's floating downloadPromise, and the process-level unhandledRejection
 * handler killed an otherwise healthy app on every launch.
 *
 * No Electron imports -- this file is testable with plain tsx --test.
 */

/**
 * True when the app is running from a macOS App Translocation mount. The
 * translocation mount is always read-only, so an update install can only fail.
 */
export function isAppTranslocated(platform: string, execPath: string): boolean {
  return platform === "darwin" && execPath.includes("/AppTranslocation/");
}

/**
 * Matches Squirrel.Mac's staging error when the app bundle lives on a
 * read-only volume (App Translocation or running straight off a mounted DMG).
 */
export function isReadOnlyVolumeUpdateError(message: string): boolean {
  return message.toLowerCase().includes("read-only volume");
}

export const UPDATE_BLOCKED_DIALOG_TITLE = "Move Closedloop to finish updating";
export const UPDATE_BLOCKED_MOVE_BUTTON = "Move & Update";
export const UPDATE_BLOCKED_LATER_BUTTON = "Later";
export const UPDATE_BLOCKED_BANNER_MESSAGE =
  PACKAGED_UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE;
export const UPDATE_BLOCKED_DIALOG_BODY =
  "Move Closedloop to the Applications folder and the latest version will install automatically. You won't need to do this again.";

/**
 * Friendly update-banner text for the read-only blocked install state.
 */
export function formatUpdateBlockedBannerMessage(_version?: string): string {
  return UPDATE_BLOCKED_BANNER_MESSAGE;
}

/**
 * Detail text for the once-per-session native dialog. The primary action moves
 * the app bundle to /Applications through app.moveToApplicationsFolder.
 */
export function formatUpdateBlockedDialogBody(_version?: string): string {
  return UPDATE_BLOCKED_DIALOG_BODY;
}

/**
 * Manual self-resolve steps, shown only when the automatic move fails. A
 * "Later" choice is respected silently: the update banner keeps showing the
 * actionable warning.
 */
export function formatUpdateBlockedManualStepsBody(version?: string): string {
  let body =
    "To update Closedloop:\n" +
    "1. Quit Closedloop\n" +
    "2. Drag Closedloop.app into your Applications folder\n" +
    "3. Relaunch it from Applications";
  if (version) {
    body += `\n\nVersion ${version} will then install automatically.`;
  }
  return body;
}

type UpdateCheckResultWithDownload = {
  downloadPromise?: Promise<unknown> | null;
} | null;

/**
 * Attach a rejection handler to the download half of a checkForUpdates()
 * result.
 *
 * electron-updater's checkForUpdates() resolves once the remote check
 * completes, but with autoDownload the download + native staging continue in
 * `result.downloadPromise`. Nothing awaited that promise, so a staging
 * failure (e.g. Squirrel.Mac's read-only-volume error) became an unhandled
 * rejection and the process-level handler exit(1)'d a healthy app — the
 * crash-on-every-launch loop in FEA-2349. The autoUpdater "error" event fires
 * for the same failures and remains the state/telemetry channel; this guard
 * only defuses the rejection.
 */
export function guardUpdateDownloadPromise(
  result: UpdateCheckResultWithDownload,
  log: (message: string) => void
): void {
  const downloadPromise = result?.downloadPromise;
  if (!downloadPromise) {
    return;
  }
  downloadPromise.catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log(`Update download/staging failed (non-fatal): ${message}`);
  });
}
