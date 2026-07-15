import { timingSafeEqual } from "node:crypto";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveApiOrigin } from "@/lib/api-origin";
import {
  getErrorRedirectUrl,
  getSuccessRedirectUrl,
  LINEAR_ERROR_CODES,
  LINEAR_OAUTH_STATE_COOKIE,
  LINEAR_PKCE_VERIFIER_COOKIE,
  type LinearErrorCode,
} from "../linear-utils";

/**
 * GET /api/integrations/linear/callback
 *
 * Handles the OAuth callback from Linear.
 * Validates state, then sends code + PKCE verifier to API for token exchange.
 * Token exchange happens in the API to keep client_secret there.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { userId, orgId, getToken } = await auth();

    if (!(userId && orgId)) {
      log.warn("[linear/callback] Not authenticated");
      return NextResponse.redirect(
        getErrorRedirectUrl(LINEAR_ERROR_CODES.NOT_AUTHENTICATED)
      );
    }

    // Read cookies early so onboarding return is available for all error redirects
    const cookieStore = await cookies();
    const onboardingReturn = cookieStore.get("onboarding_return")?.value;
    const returnTo = onboardingReturn ? "/onboarding" : undefined;

    const makeErrorRedirect = (code: LinearErrorCode): NextResponse => {
      const response = NextResponse.redirect(
        getErrorRedirectUrl(code, returnTo)
      );
      if (onboardingReturn) {
        response.cookies.delete("onboarding_return");
      }
      return response;
    };

    const { searchParams } = new URL(request.url);

    // Check for OAuth errors from Linear
    const error = searchParams.get("error");
    if (error) {
      const errorDescription = searchParams.get("error_description");
      log.warn("[linear/callback] OAuth error from Linear", {
        error,
        errorDescription,
      });
      return makeErrorRedirect(LINEAR_ERROR_CODES.OAUTH_FAILED);
    }

    // Get code and state from URL
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!(code && state)) {
      log.warn("[linear/callback] Missing code or state");
      return makeErrorRedirect(LINEAR_ERROR_CODES.MISSING_PARAMS);
    }

    // Verify state (CSRF protection)
    const storedState = cookieStore.get(LINEAR_OAUTH_STATE_COOKIE)?.value;
    const codeVerifier = cookieStore.get(LINEAR_PKCE_VERIFIER_COOKIE)?.value;

    if (!storedState) {
      log.warn("[linear/callback] Missing stored state");
      return makeErrorRedirect(LINEAR_ERROR_CODES.INVALID_STATE);
    }

    // Timing-safe comparison (pad to equal length to avoid timing leak on length check)
    const stateMatch = verifyTimingSafe(storedState, state);

    if (!stateMatch) {
      log.warn("[linear/callback] State mismatch");
      return makeErrorRedirect(LINEAR_ERROR_CODES.INVALID_STATE);
    }

    if (!codeVerifier) {
      log.warn("[linear/callback] Missing PKCE verifier");
      return makeErrorRedirect(LINEAR_ERROR_CODES.INVALID_REQUEST);
    }

    // Send code + verifier to API for token exchange
    // Token exchange happens in API to keep client_secret there
    const clerkToken = await getToken();
    const apiResponse = await fetch(
      `${resolveApiOrigin(request)}/integrations/linear/connect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clerkToken}`,
        },
        body: JSON.stringify({
          code,
          codeVerifier,
        }),
      }
    );

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      // Redact sensitive data from error logs - only log status and truncated message
      log.error("[linear/callback] Failed to connect Linear", {
        status: apiResponse.status,
        error:
          apiResponse.status >= 500
            ? "Internal server error"
            : errorBody.slice(0, 200),
      });
      const errorResponse = makeErrorRedirect(
        LINEAR_ERROR_CODES.CONNECTION_FAILED
      );
      errorResponse.cookies.delete(LINEAR_OAUTH_STATE_COOKIE);
      errorResponse.cookies.delete(LINEAR_PKCE_VERIFIER_COOKIE);
      return errorResponse;
    }

    log.info("[linear/callback] Linear connected successfully", {
      userId,
      orgId,
    });

    // Clear cookies and redirect using response object pattern (Next.js App Router best practice)
    const response = NextResponse.redirect(getSuccessRedirectUrl(returnTo));
    response.cookies.delete(LINEAR_OAUTH_STATE_COOKIE);
    response.cookies.delete(LINEAR_PKCE_VERIFIER_COOKIE);
    if (onboardingReturn) {
      response.cookies.delete("onboarding_return");
    }
    return response;
  } catch (error) {
    log.error("[linear/callback] Failed to complete OAuth", { error });
    return NextResponse.redirect(
      getErrorRedirectUrl(LINEAR_ERROR_CODES.OAUTH_FAILED)
    );
  }
}

/**
 * Timing-safe string comparison with padding to prevent timing attacks on length.
 */
function verifyTimingSafe(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  const maxLength = Math.max(expectedBuffer.length, actualBuffer.length);

  const paddedExpected = Buffer.alloc(maxLength);
  const paddedActual = Buffer.alloc(maxLength);
  expectedBuffer.copy(paddedExpected);
  actualBuffer.copy(paddedActual);

  const lengthsMatch = expectedBuffer.length === actualBuffer.length;
  const contentsMatch = timingSafeEqual(paddedExpected, paddedActual);

  return lengthsMatch && contentsMatch;
}
