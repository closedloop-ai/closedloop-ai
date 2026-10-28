import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  GITHUB_CLERK_LINK_PATH,
  GITHUB_RESUME_INSTALLATION_ID_PARAM,
} from "@repo/api/src/types/github-clerk-link";
import {
  GitHubConnectReturnStatus,
  type GitHubErrorCode,
} from "@repo/api/src/types/github-status";
import { z } from "zod";
import { getCompatibleGitHubReturnPath } from "@/app/api/integrations/github/github-return-path";
import { env } from "@/env";

// Cookie name for OAuth state (CSRF protection)
export const GITHUB_OAUTH_STATE_COOKIE = "github_oauth_state";
export const GITHUB_OAUTH_RETURN_TO_COOKIE = "github_oauth_return_to";
export const GITHUB_OAUTH_RETURN_TO_COOKIE_PATH = "/api/integrations/github";

const GITHUB_OAUTH_RETURN_TO_COOKIE_VERSION = 1;
const GITHUB_OAUTH_RETURN_TO_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
const GITHUB_OAUTH_RETURN_TO_STATE_HASH_PREFIX = "github_oauth_return_to:v1:";
/** GitHub installation ids are positive integers; anything else is not ours. */
const NUMERIC_INSTALLATION_ID_PATTERN = /^\d{1,20}$/u;
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

/** Serialize a state-bound return cookie for GitHub OAuth. */
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

/** Verify a GitHub OAuth return cookie after OAuth state passes. */
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
  return getCompatibleGitHubReturnPath(parsed.payload.returnTo);
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
  url.searchParams.set("github", GitHubConnectReturnStatus.Error);
  url.searchParams.set("code", errorCode);
  return url.toString();
}

/**
 * Redirect target when a claim was refused only because the caller has no
 * usable Clerk GitHub grant (PLN-1742 M5). The App is already installed at
 * this point, so the generic "Failed to connect" error would be a dead end:
 * linking is the one action that fixes it, and `resumeInstallationId` lets
 * the linking page finish the claim instead of making the user re-install.
 * The id is echoed only after a digits check — it arrives on a query string.
 */
export function getGitHubLinkRedirectUrl(
  installationId: string,
  returnTo?: string
): string {
  const url = new URL(GITHUB_CLERK_LINK_PATH, env.NEXT_PUBLIC_APP_URL);
  if (returnTo) {
    url.searchParams.set("returnTo", returnTo);
  }
  if (NUMERIC_INSTALLATION_ID_PATTERN.test(installationId)) {
    url.searchParams.set(GITHUB_RESUME_INSTALLATION_ID_PARAM, installationId);
  }
  return url.toString();
}

/**
 * Get the success redirect URL after OAuth completion.
 */
export function getSuccessRedirectUrl(returnTo?: string): string {
  const base = returnTo ?? "/settings";
  const url = new URL(base, env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("github", GitHubConnectReturnStatus.Connected);
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
