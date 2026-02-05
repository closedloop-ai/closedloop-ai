import { timingSafeEqual } from "node:crypto";
import { env } from "@/env";

// Cookie name for OAuth state (CSRF protection)
export const GITHUB_OAUTH_STATE_COOKIE = "github_oauth_state";

/**
 * Timing-safe string comparison.
 * Pads strings to equal length to prevent timing attacks based on string length.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Error codes for OAuth failures.
 * Using an allowlist prevents open redirect attacks via error messages.
 */
export const GITHUB_ERROR_CODES = {
  NOT_AUTHENTICATED: "not_authenticated",
  NOT_CONFIGURED: "not_configured",
  MISSING_PARAMS: "missing_params",
  INVALID_STATE: "invalid_state",
  INVALID_REQUEST: "invalid_request",
  CONNECTION_FAILED: "connection_failed",
  OAUTH_FAILED: "oauth_failed",
  TOKEN_EXCHANGE_FAILED: "token_exchange_failed",
} as const;

export type GitHubErrorCode =
  (typeof GITHUB_ERROR_CODES)[keyof typeof GITHUB_ERROR_CODES];

/**
 * Get the GitHub OAuth callback URL.
 */
export function getGitHubCallbackUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/api/integrations/github/callback`;
}

/**
 * Get the error redirect URL for OAuth failures.
 * Uses error codes instead of free-form strings to prevent open redirect attacks.
 */
export function getErrorRedirectUrl(errorCode: GitHubErrorCode): string {
  return `${env.NEXT_PUBLIC_APP_URL}/settings?github=error&code=${errorCode}`;
}

/**
 * Get the success redirect URL after OAuth completion.
 */
export function getSuccessRedirectUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/settings?github=connected`;
}
