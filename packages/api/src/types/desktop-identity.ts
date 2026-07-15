/**
 * Display identity for the authenticated first-party desktop session
 * (FEA-2219). Returned by `GET /desktop/identity` and shown on the desktop
 * Settings → Account tab so a signed-in user sees their name/email and
 * organization name rather than the raw database ids the session token carries.
 *
 * Shared here (per the "never define the same contract twice" rule) so the API
 * route that produces it and the desktop main process that consumes it agree on
 * one shape.
 */
export type DesktopIdentity = {
  userId: string;
  organizationId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
};
