import { timingSafeEqual } from "node:crypto";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import {
  getErrorRedirectUrl,
  getSuccessRedirectUrl,
  LINEAR_ERROR_CODES,
  LINEAR_OAUTH_STATE_COOKIE,
  LINEAR_PKCE_VERIFIER_COOKIE,
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

    const { searchParams } = new URL(request.url);

    // Check for OAuth errors from Linear
    const error = searchParams.get("error");
    if (error) {
      const errorDescription = searchParams.get("error_description");
      log.warn("[linear/callback] OAuth error from Linear", {
        error,
        errorDescription,
      });
      return NextResponse.redirect(
        getErrorRedirectUrl(LINEAR_ERROR_CODES.OAUTH_FAILED)
      );
    }

    // Get code and state from URL
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!(code && state)) {
      log.warn("[linear/callback] Missing code or state");
      return NextResponse.redirect(
        getErrorRedirectUrl(LINEAR_ERROR_CODES.MISSING_PARAMS)
      );
    }

    // Verify state (CSRF protection)
    const cookieStore = await cookies();
    const storedState = cookieStore.get(LINEAR_OAUTH_STATE_COOKIE)?.value;
    const codeVerifier = cookieStore.get(LINEAR_PKCE_VERIFIER_COOKIE)?.value;

    if (!storedState) {
      log.warn("[linear/callback] Missing stored state");
      return NextResponse.redirect(
        getErrorRedirectUrl(LINEAR_ERROR_CODES.INVALID_STATE)
      );
    }

    // Timing-safe comparison (pad to equal length to avoid timing leak on length check)
    const storedStateBuffer = Buffer.from(storedState, "utf8");
    const stateBuffer = Buffer.from(state, "utf8");
    const maxLength = Math.max(storedStateBuffer.length, stateBuffer.length);

    // Pad buffers to equal length for constant-time comparison
    const paddedStored = Buffer.alloc(maxLength);
    const paddedState = Buffer.alloc(maxLength);
    storedStateBuffer.copy(paddedStored);
    stateBuffer.copy(paddedState);

    // Check both length match AND content matches (constant-time)
    const lengthsMatch = storedStateBuffer.length === stateBuffer.length;
    const contentsMatch = timingSafeEqual(paddedStored, paddedState);

    if (!(lengthsMatch && contentsMatch)) {
      log.warn("[linear/callback] State mismatch");
      return NextResponse.redirect(
        getErrorRedirectUrl(LINEAR_ERROR_CODES.INVALID_STATE)
      );
    }

    if (!codeVerifier) {
      log.warn("[linear/callback] Missing PKCE verifier");
      return NextResponse.redirect(
        getErrorRedirectUrl(LINEAR_ERROR_CODES.INVALID_REQUEST)
      );
    }

    // Send code + verifier to API for token exchange
    // Token exchange happens in API to keep client_secret there
    const clerkToken = await getToken();
    const apiResponse = await fetch(
      `${env.NEXT_PUBLIC_API_URL}/integrations/linear/connect`,
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

    // Check if user should return to onboarding after OAuth
    const onboardingReturn = cookieStore.get("onboarding_return")?.value;
    const returnTo = onboardingReturn ? "/onboarding" : undefined;

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      // Redact sensitive data from error logs - only log status and truncated message
      log.error("[linear/callback] Failed to connect Linear", {
        status: apiResponse.status,
        error:
          apiResponse.status >= 500
            ? "Internal server error"
            : errorBody.substring(0, 200),
      });
      const errorResponse = NextResponse.redirect(
        getErrorRedirectUrl(LINEAR_ERROR_CODES.CONNECTION_FAILED, returnTo)
      );
      errorResponse.cookies.delete(LINEAR_OAUTH_STATE_COOKIE);
      errorResponse.cookies.delete(LINEAR_PKCE_VERIFIER_COOKIE);
      if (onboardingReturn) {
        errorResponse.cookies.delete("onboarding_return");
      }
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
