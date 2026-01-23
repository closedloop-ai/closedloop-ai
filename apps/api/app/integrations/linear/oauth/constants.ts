/**
 * Shared constants for Linear OAuth flow.
 * Used by both oauth initiation and callback routes.
 */

// Cookie names for OAuth state and PKCE verification
export const LINEAR_OAUTH_STATE_COOKIE = "linear_oauth_state";
export const LINEAR_PKCE_VERIFIER_COOKIE = "linear_pkce_verifier";
// Cookie to store auth context for callback (since Clerk cookies don't work cross-domain)
export const LINEAR_AUTH_CONTEXT_COOKIE = "linear_auth_context";

/**
 * Get the base app URL for redirects.
 */
function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

/**
 * Build error redirect URL for OAuth failures.
 * @param error - Optional error message to include in query params
 */
export function getOAuthErrorRedirectUrl(error?: string): string {
  const url = `${getAppUrl()}/settings?linear=error`;
  return error ? `${url}&error=${encodeURIComponent(error)}` : url;
}

/**
 * Build success redirect URL for OAuth completion.
 */
export function getOAuthSuccessRedirectUrl(): string {
  return `${getAppUrl()}/settings?linear=connected`;
}
