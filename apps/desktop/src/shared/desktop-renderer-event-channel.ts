/**
 * Channels main pushes to the renderer (`webContents.send`) and the preload
 * bridge subscribes to with `ipcRenderer.on`. Shared so the sender and the
 * listener cannot drift apart on a rename (ISS-11406).
 */
export const DesktopRendererEventChannel = {
  NavigateTab: "desktop:navigate-tab",
  UpdateAvailable: "desktop:update-available",
  UpdateStatus: "desktop:update-status",
  OnboardingStateChanged: "desktop:onboarding-state-changed",
  ShowOnboardingPopup: "desktop:show-onboarding-popup",
  DbChanged: "desktop:db:changed",
  DbReady: "desktop:db:ready",
  GithubResyncNudge: "desktop:github-resync-nudge",
  PackInstallOutput: "desktop:pack:install-output",
  DistributionsOptInAvailable: "desktop:distributions:opt-in-available",
  AuthStateChanged: "desktop:auth-state-changed",
  SyncConsentChanged: "desktop:sync-consent-changed",
  FlagsChanged: "desktop:flags-changed",
  /** PLN-2162 M4: a `DesktopRealtimeEvent` for the renderer's realtime port. */
  Realtime: "desktop:realtime:event",
} as const;

export type DesktopRendererEventChannel =
  (typeof DesktopRendererEventChannel)[keyof typeof DesktopRendererEventChannel];
