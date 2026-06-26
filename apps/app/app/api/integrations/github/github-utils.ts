import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/env";

// Cookie name for OAuth state (CSRF protection)
export const GITHUB_OAUTH_STATE_COOKIE = "github_oauth_state";
export const GITHUB_OAUTH_RETURN_TO_COOKIE = "github_oauth_return_to";
export const GITHUB_OAUTH_RETURN_TO_COOKIE_PATH = "/api/integrations/github";

const GITHUB_OAUTH_RETURN_TO_COOKIE_VERSION = 1;
const GITHUB_OAUTH_RETURN_TO_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
const GITHUB_OAUTH_RETURN_TO_STATE_HASH_PREFIX = "github_oauth_return_to:v1:";
const ENCODED_SEPARATOR_OR_DOT_PATTERN = /%(?:2e|2f|5c)/i;
const CR_LF_OR_BACKSLASH_PATTERN = /[\r\n\\]/;
const returnToPayloadSchema = z
  .object({
    v: z.literal(GITHUB_OAUTH_RETURN_TO_COOKIE_VERSION),
    returnTo: z.string(),
    stateHash: z.string(),
    issuedAt: z.number().int().refine(Number.isSafeInteger),
  })
  .strict();
type ReturnToPayload = z.infer<typeof returnToPayloadSchema>;

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

/** Validate the only custom OAuth return target Branch View prompts support. */
export function getCanonicalBranchViewReturnPath(
  returnTo: string | null
): string | null {
  if (!returnTo || returnTo.length > 200) {
    return null;
  }
  if (
    CR_LF_OR_BACKSLASH_PATTERN.test(returnTo) ||
    ENCODED_SEPARATOR_OR_DOT_PATTERN.test(returnTo) ||
    returnTo.startsWith("//") ||
    returnTo.includes("?") ||
    returnTo.includes("#") ||
    returnTo.startsWith("/api/")
  ) {
    return null;
  }
  const [, orgSlug, buildSegment, buildId, ...extra] = returnTo.split("/");
  if (
    extra.length > 0 ||
    buildSegment !== "build" ||
    !isSafeBranchViewPathSegment(orgSlug) ||
    !isSafeBranchViewPathSegment(buildId)
  ) {
    return null;
  }
  return `/${orgSlug}/build/${buildId}`;
}

/** Serialize a state-bound Branch View return cookie for GitHub OAuth. */
export function createGitHubOAuthReturnToCookie(input: {
  issuedAt: number;
  returnTo: string;
  state: string;
}): string {
  const payload = {
    v: GITHUB_OAUTH_RETURN_TO_COOKIE_VERSION,
    returnTo: input.returnTo,
    stateHash: stateHash(input.state),
    issuedAt: input.issuedAt,
  } satisfies { v: 1; returnTo: string; stateHash: string; issuedAt: number };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const macB64 = hmacReturnPayload(input.state, payload);
  return `v1.${payloadB64}.${macB64}`;
}

/** Verify a GitHub OAuth Branch View return cookie after OAuth state passes. */
export function verifyGitHubOAuthReturnToCookie(input: {
  cookieValue: string | undefined;
  now: number;
  state: string;
}): string | null {
  const parsed = parseReturnToCookie(input.cookieValue);
  if (!parsed) {
    return null;
  }
  if (
    input.now - parsed.payload.issuedAt < 0 ||
    input.now - parsed.payload.issuedAt >
      GITHUB_OAUTH_RETURN_TO_COOKIE_MAX_AGE_MS
  ) {
    return null;
  }
  if (!timingSafeCompare(parsed.payload.stateHash, stateHash(input.state))) {
    return null;
  }
  if (
    !timingSafeCompare(
      parsed.mac,
      hmacReturnPayload(input.state, parsed.payload)
    )
  ) {
    return null;
  }
  return getCanonicalBranchViewReturnPath(parsed.payload.returnTo);
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
export function getErrorRedirectUrl(
  errorCode: GitHubErrorCode,
  returnTo?: string
): string {
  const base = returnTo ?? "/settings";
  const url = new URL(base, env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("github", "error");
  url.searchParams.set("code", errorCode);
  return url.toString();
}

/**
 * Get the success redirect URL after OAuth completion.
 */
export function getSuccessRedirectUrl(returnTo?: string): string {
  const base = returnTo ?? "/settings";
  const url = new URL(base, env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("github", "connected");
  return url.toString();
}

/**
 * Redirect target when the OAuth callback detects that the org is being
 * reconnected to a different GitHub account than was previously linked
 * (PLN-634). Always routes to /settings because the confirmation dialog
 * lives there — onboarding has no surface that can handle this state.
 */
export function getRequiresConfirmationRedirectUrl(input: {
  priorAccountId: string;
  priorAccountLogin: string;
  newAccountId: string;
  newAccountLogin: string;
  newInstallationId: string;
}): string {
  const params = new URLSearchParams({
    github: "requires_confirmation",
    priorAccountId: input.priorAccountId,
    priorAccountLogin: input.priorAccountLogin,
    newAccountId: input.newAccountId,
    newAccountLogin: input.newAccountLogin,
    newInstallationId: input.newInstallationId,
  });
  return `${env.NEXT_PUBLIC_APP_URL}/settings?${params.toString()}`;
}

function parseReturnToCookie(value: string | undefined): {
  mac: string;
  payload: ReturnToPayload;
} | null {
  if (!value) {
    return null;
  }
  const [version, payloadB64, mac, ...extra] = value.split(".");
  if (version !== "v1" || !payloadB64 || !mac || extra.length > 0) {
    return null;
  }
  try {
    const raw = JSON.parse(base64UrlDecode(payloadB64));
    const parsed = returnToPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    return { mac, payload: parsed.data };
  } catch {
    return null;
  }
}

function hmacReturnPayload(state: string, payload: ReturnToPayload): string {
  const canonical = `v=1\nreturnTo=${payload.returnTo}\nstateHash=${payload.stateHash}\nissuedAt=${payload.issuedAt}`;
  return createHmac("sha256", state).update(canonical).digest("base64url");
}

function stateHash(state: string): string {
  return createHash("sha256")
    .update(`${GITHUB_OAUTH_RETURN_TO_STATE_HASH_PREFIX}${state}`)
    .digest("base64url");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function isSafeBranchViewPathSegment(value: string | undefined): boolean {
  return Boolean(
    value &&
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("%")
  );
}
