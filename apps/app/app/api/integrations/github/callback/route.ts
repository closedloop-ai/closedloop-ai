import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import {
  GITHUB_ERROR_CODES,
  GITHUB_OAUTH_STATE_COOKIE,
  getErrorRedirectUrl,
  getSuccessRedirectUrl,
  timingSafeCompare,
} from "../github-utils";

/**
 * GET /api/integrations/github/callback
 *
 * Handles the OAuth callback from GitHub.
 * Validates state, then sends code + installation ID to API for token exchange.
 * Token exchange happens in the API to keep client_secret there.
 *
 * GitHub passes three params when "OAuth during installation" is enabled:
 * - code: OAuth authorization code
 * - state: CSRF token
 * - installation_id: GitHub App installation ID
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { userId, orgId, getToken } = await auth();

    if (!(userId && orgId)) {
      log.warn("[github/callback] Not authenticated");
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.NOT_AUTHENTICATED)
      );
    }

    const { searchParams } = new URL(request.url);

    // Check for OAuth errors from GitHub
    const error = searchParams.get("error");
    if (error) {
      const errorDescription = searchParams.get("error_description");
      log.warn("[github/callback] OAuth error from GitHub", {
        error,
        errorDescription,
      });
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.OAUTH_FAILED)
      );
    }

    // Get code, state, and installation_id from URL
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const installationId = searchParams.get("installation_id");

    // Log params for debugging (redact sensitive values)
    log.info("[github/callback] Received callback params", {
      hasCode: !!code,
      hasState: !!state,
      hasInstallationId: !!installationId,
      installationId,
    });

    if (!(code && state && installationId)) {
      log.warn("[github/callback] Missing required params", {
        hasCode: !!code,
        hasState: !!state,
        hasInstallationId: !!installationId,
      });
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.MISSING_PARAMS)
      );
    }

    // Verify state (CSRF protection)
    const cookieStore = await cookies();
    const storedState = cookieStore.get(GITHUB_OAUTH_STATE_COOKIE)?.value;

    if (!storedState) {
      log.warn("[github/callback] Missing stored state");
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.INVALID_STATE)
      );
    }

    // Timing-safe state comparison to prevent CSRF
    if (!timingSafeCompare(storedState, state)) {
      log.warn("[github/callback] State mismatch");
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.INVALID_STATE)
      );
    }

    // Send code + installationId to API for token exchange
    // Token exchange happens in API to keep client_secret there
    const clerkToken = await getToken();
    const apiResponse = await fetch(
      `${env.NEXT_PUBLIC_API_URL}/integrations/github/connect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clerkToken}`,
        },
        body: JSON.stringify({
          code,
          installationId,
        }),
      }
    );

    // Check if user should return to onboarding after OAuth
    const onboardingReturn = cookieStore.get("onboarding_return")?.value;
    const returnTo = onboardingReturn ? "/onboarding" : undefined;

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      // Redact sensitive data from error logs - only log status and truncated message
      log.error("[github/callback] Failed to connect GitHub", {
        status: apiResponse.status,
        error:
          apiResponse.status >= 500
            ? "Internal server error"
            : errorBody.substring(0, 200),
      });
      const errorResponse = NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.CONNECTION_FAILED, returnTo)
      );
      errorResponse.cookies.delete(GITHUB_OAUTH_STATE_COOKIE);
      if (onboardingReturn) {
        errorResponse.cookies.delete("onboarding_return");
      }
      return errorResponse;
    }

    log.info("[github/callback] GitHub connected successfully", {
      userId,
      orgId,
    });

    // Clear cookies and redirect using response object pattern (Next.js App Router best practice)
    const response = NextResponse.redirect(getSuccessRedirectUrl(returnTo));
    response.cookies.delete(GITHUB_OAUTH_STATE_COOKIE);
    if (onboardingReturn) {
      response.cookies.delete("onboarding_return");
    }
    return response;
  } catch (error) {
    log.error("[github/callback] Failed to complete OAuth", { error });
    return NextResponse.redirect(
      getErrorRedirectUrl(GITHUB_ERROR_CODES.OAUTH_FAILED)
    );
  }
}
