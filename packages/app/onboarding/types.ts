/**
 * Neutral type module for the Desktop-first onboarding feature slice.
 *
 * Both the data hook (`hooks/use-desktop-onboarding`) and the pure logic in
 * `lib/` depend on this shape, so it lives here rather than in the hook — that
 * keeps the lower-level `lib/` modules from importing the higher-level `hooks/`
 * layer (dependency direction stays pointing inward).
 */

/** Non-secret browser-approval projection of a pending desktop device session. */
export type DesktopDeviceSessionDetails = {
  userCode: string;
  machineName: string;
  platform: string;
  webAppOrigin: string;
  status: string;
  createdAt: string;
  expiresAt: string;
};
