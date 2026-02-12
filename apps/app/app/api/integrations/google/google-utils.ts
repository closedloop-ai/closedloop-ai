import { env } from "@/env";

// Cookie names for OAuth state and PKCE verification
export const GOOGLE_STATE_COOKIE = "google_oauth_state";
export const GOOGLE_VERIFIER_COOKIE = "google_oauth_verifier";

// Google OAuth URL
export const GOOGLE_OAUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Error codes for OAuth failures.
 * Using an allowlist prevents open redirect attacks via error messages.
 */
export const GOOGLE_OAUTH_ERRORS = {
  INVALID_STATE: "invalid_state",
  OAUTH_FAILED: "oauth_failed",
  TOKEN_EXCHANGE_FAILED: "token_exchange_failed",
  NOT_AUTHENTICATED: "not_authenticated",
  NOT_CONFIGURED: "not_configured",
  MISSING_PARAMS: "missing_params",
} as const;

export type GoogleOAuthError =
  (typeof GOOGLE_OAUTH_ERRORS)[keyof typeof GOOGLE_OAUTH_ERRORS];

/**
 * Get the OAuth initiation route.
 * This returns the local route that initiates the OAuth flow.
 */
export function getGoogleOAuthUrl(): string {
  return "/api/integrations/google";
}

/**
 * Get the Google OAuth callback URL.
 * This is the URL Google will redirect to after user authorizes.
 */
export function getGoogleCallbackUrl(): string {
  if (!env.NEXT_PUBLIC_APP_URL) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL is not set. Cannot construct Google OAuth callback URL."
    );
  }
  return `${env.NEXT_PUBLIC_APP_URL}/api/integrations/google/callback`;
}

/**
 * Build the full Google OAuth authorization URL.
 * Constructs the URL with all required OAuth 2.0 parameters.
 *
 * @param state - CSRF protection token
 * @param codeChallenge - PKCE code challenge
 * @param redirectUri - Callback URL for OAuth
 * @param clientId - Google OAuth client ID
 */
export function buildGoogleAuthUrl(
  state: string,
  codeChallenge: string,
  redirectUri: string,
  clientId: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline", // Request refresh token
    prompt: "consent", // Force consent screen to ensure refresh token
  });

  return `${GOOGLE_OAUTH_URL}?${params.toString()}`;
}
