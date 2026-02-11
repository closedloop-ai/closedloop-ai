import { env } from "@/env";

// Cookie names for OAuth state and PKCE verification
export const LINEAR_OAUTH_STATE_COOKIE = "linear_oauth_state";
export const LINEAR_PKCE_VERIFIER_COOKIE = "linear_pkce_verifier";

// Linear OAuth URL
export const LINEAR_OAUTH_URL = "https://linear.app/oauth/authorize";

/**
 * Error codes for OAuth failures.
 * Using an allowlist prevents open redirect attacks via error messages.
 */
export const LINEAR_ERROR_CODES = {
  NOT_AUTHENTICATED: "not_authenticated",
  NOT_CONFIGURED: "not_configured",
  MISSING_PARAMS: "missing_params",
  INVALID_STATE: "invalid_state",
  INVALID_REQUEST: "invalid_request",
  CONNECTION_FAILED: "connection_failed",
  OAUTH_FAILED: "oauth_failed",
} as const;

export type LinearErrorCode =
  (typeof LINEAR_ERROR_CODES)[keyof typeof LINEAR_ERROR_CODES];

/**
 * Get the Linear OAuth callback URL.
 */
export function getLinearCallbackUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/api/integrations/linear/callback`;
}

/**
 * Get the error redirect URL for OAuth failures.
 * Uses error codes instead of free-form strings to prevent open redirect attacks.
 */
export function getErrorRedirectUrl(errorCode: LinearErrorCode): string {
  return `${env.NEXT_PUBLIC_APP_URL}/settings?linear=error&code=${errorCode}`;
}

/**
 * Get the success redirect URL after OAuth completion.
 */
export function getSuccessRedirectUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/settings?linear=connected`;
}
