import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";

/**
 * @file clerk-oauth-strategy.ts
 * @description The Clerk strategy id per social connection, in one place so the
 * desktop sign-in redirect, the GitHub link page, and the Settings Profile
 * panel cannot drift onto different strategy strings.
 *
 * CLIENT-OWNED on purpose. This is Clerk SDK policy, not a transport contract:
 * the desktop authorize URL carries the PROVIDER vocabulary, never this
 * strategy string, and no `apps/api` route reads it. `packages/api` is for
 * contracts both apps share, so a value only browser code hands to Clerk lives
 * here instead.
 */
export const CLERK_OAUTH_STRATEGY = {
  [DesktopSignInProvider.GitHub]: "oauth_github",
  [DesktopSignInProvider.Google]: "oauth_google",
} as const satisfies Record<DesktopSignInProvider, string>;
