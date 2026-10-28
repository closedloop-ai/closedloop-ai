/**
 * Web-shell paths that INITIATE a browser OAuth redirect for a plugin.
 *
 * These are app routes the browser navigates to, never fetched through the API
 * client. They live in this dependency-free `@repo/api` leaf — the arrangement
 * `GITHUB_CLERK_LINK_PATH` already uses — because two surfaces now need the same
 * literal: `apps/app/lib/integration-connect-urls.ts` builds the legacy
 * Settings card's href from it, and the Settings v2 Plugins panel in
 * `packages/app` renders its connect action from it (ISS-8369). `packages/app`
 * cannot import from `apps/app`, so without a shared leaf the path would be
 * re-declared and the two copies would drift on the next route change.
 *
 * The flow itself remains web-shell-specific: a desktop renderer would drive
 * OAuth through a system browser and a loopback callback, which is why the
 * Plugins panel declares `hosts: [web]` rather than pretending this path works
 * inside Electron.
 */

/**
 * Google Drive's connect route: the legacy Settings card and the Settings v2
 * Plugins panel (ISS-10316) both render it.
 */
export const GOOGLE_OAUTH_CONNECT_PATH = "/api/integrations/google" as const;

/**
 * The query key the Google OAuth routes return to Settings with, and its
 * values. Read by the Settings v2 Plugins panel (ISS-10316); `message` carries
 * the error code on a failed round trip.
 */
export const GOOGLE_OAUTH_CALLBACK_PARAM = "google" as const;
export const GOOGLE_OAUTH_CALLBACK_MESSAGE_PARAM = "message" as const;

export const GoogleOAuthCallbackOutcome = {
  Success: "success",
  Error: "error",
} as const;

export type GoogleOAuthCallbackOutcome =
  (typeof GoogleOAuthCallbackOutcome)[keyof typeof GoogleOAuthCallbackOutcome];
