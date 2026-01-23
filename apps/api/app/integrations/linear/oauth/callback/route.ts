import { timingSafeEqual } from "node:crypto";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { linearService } from "../../service";
import {
  getOAuthErrorRedirectUrl,
  getOAuthSuccessRedirectUrl,
  LINEAR_AUTH_CONTEXT_COOKIE,
  LINEAR_OAUTH_STATE_COOKIE,
  LINEAR_PKCE_VERIFIER_COOKIE,
} from "../constants";

type OAuthCallbackParams = {
  code: string;
  codeVerifier: string;
};

type OAuthValidationResult =
  | { valid: true; params: OAuthCallbackParams }
  | { valid: false; error: string };

/**
 * Validate OAuth callback parameters and cookies.
 * Extracts and validates code, state, and PKCE verifier.
 */
async function validateOAuthCallback(
  searchParams: URLSearchParams
): Promise<OAuthValidationResult> {
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  // Handle OAuth errors from Linear
  if (error) {
    log.warn("[linear/oauth/callback] OAuth error from Linear", {
      error,
      errorDescription,
    });
    // Return generic error to avoid leaking Linear API details
    return {
      valid: false,
      error: "OAuth authorization failed. Please try again.",
    };
  }

  // Validate required parameters
  if (!(code && state)) {
    log.warn("[linear/oauth/callback] Missing code or state", {
      hasCode: !!code,
      hasState: !!state,
    });
    return { valid: false, error: "Missing authorization parameters" };
  }

  // Verify state and get PKCE verifier from cookies
  const cookieStore = await cookies();
  const storedState = cookieStore.get(LINEAR_OAUTH_STATE_COOKIE)?.value;
  const codeVerifier = cookieStore.get(LINEAR_PKCE_VERIFIER_COOKIE)?.value;

  // SECURITY: Use constant-time comparison to prevent timing attacks on state parameter
  if (!storedState) {
    log.warn("[linear/oauth/callback] Missing stored state");
    return { valid: false, error: "Invalid state parameter" };
  }

  try {
    const storedStateBuffer = Buffer.from(storedState, "utf8");
    const stateBuffer = Buffer.from(state, "utf8");

    // Ensure buffers are same length before comparison (required by timingSafeEqual)
    if (storedStateBuffer.length !== stateBuffer.length) {
      log.warn("[linear/oauth/callback] State length mismatch");
      return { valid: false, error: "Invalid state parameter" };
    }

    if (!timingSafeEqual(storedStateBuffer, stateBuffer)) {
      log.warn("[linear/oauth/callback] State mismatch (constant-time check)");
      return { valid: false, error: "Invalid state parameter" };
    }
  } catch (validationError) {
    log.warn("[linear/oauth/callback] State validation error", {
      error:
        validationError instanceof Error
          ? validationError.message
          : String(validationError),
    });
    return { valid: false, error: "Invalid state parameter" };
  }

  if (!codeVerifier) {
    log.warn("[linear/oauth/callback] Missing PKCE verifier");
    return { valid: false, error: "Invalid authorization request" };
  }

  // Clear the state and PKCE cookies (auth context cleared after use in GET handler)
  cookieStore.delete(LINEAR_OAUTH_STATE_COOKIE);
  cookieStore.delete(LINEAR_PKCE_VERIFIER_COOKIE);

  return { valid: true, params: { code, codeVerifier } };
}

type AuthContext = {
  organizationId: string;
  clerkUserId: string;
};

/**
 * GET /integrations/linear/oauth/callback
 *
 * Handles the OAuth callback from Linear.
 * Exchanges the authorization code for tokens and stores them.
 *
 * Note: This route does NOT use withAuth middleware because:
 * 1. It must return HTTP redirects (not JSON responses)
 * 2. It needs to handle browser-based OAuth flow with cookies
 * 3. Authentication is verified via auth context cookie (Clerk cookies don't work cross-domain)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Validate OAuth callback parameters and cookies
  const { searchParams } = new URL(request.url);
  const validation = await validateOAuthCallback(searchParams);
  if (!validation.valid) {
    return NextResponse.redirect(getOAuthErrorRedirectUrl(validation.error));
  }
  const { code, codeVerifier } = validation.params;

  // Get auth context from cookie (set during OAuth initiation)
  const cookieStore = await cookies();
  const authContextCookie = cookieStore.get(LINEAR_AUTH_CONTEXT_COOKIE)?.value;

  if (!authContextCookie) {
    log.warn("[linear/oauth/callback] Missing auth context cookie");
    return NextResponse.redirect(
      getOAuthErrorRedirectUrl("Authentication expired. Please try again.")
    );
  }

  let authContext: AuthContext;
  try {
    authContext = JSON.parse(authContextCookie) as AuthContext;
  } catch {
    log.warn("[linear/oauth/callback] Invalid auth context cookie");
    return NextResponse.redirect(
      getOAuthErrorRedirectUrl("Authentication error. Please try again.")
    );
  }

  // Clear the auth context cookie
  cookieStore.delete(LINEAR_AUTH_CONTEXT_COOKIE);

  const { organizationId, clerkUserId } = authContext;

  // Complete OAuth callback via service layer
  const result = await linearService.completeOAuthCallback(
    code,
    codeVerifier,
    organizationId,
    clerkUserId
  );

  if (!result.success) {
    return NextResponse.redirect(getOAuthErrorRedirectUrl(result.error));
  }

  return NextResponse.redirect(getOAuthSuccessRedirectUrl());
}
