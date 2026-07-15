import type { ConnectGitHubResponse } from "@repo/api/src/types/github";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveApiOrigin } from "@/lib/api-origin";
import {
  GITHUB_ERROR_CODES,
  GITHUB_OAUTH_RETURN_TO_COOKIE,
  GITHUB_OAUTH_RETURN_TO_COOKIE_PATH,
  GITHUB_OAUTH_STATE_COOKIE,
  type GitHubErrorCode,
  getErrorRedirectUrl,
  getRequiresConfirmationRedirectUrl,
  getSuccessRedirectUrl,
  timingSafeCompare,
  verifyGitHubOAuthReturnToCookie,
} from "../github-utils";

type ConnectGitHubResponseBody = { data?: ConnectGitHubResponse };

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
    // Read cookies before any branch can return so every callback clears stale
    // OAuth state, Branch View return, and onboarding cookies consistently.
    const cookieStore = await cookies();
    const onboardingReturn = cookieStore.get("onboarding_return")?.value;
    const onboardingReturnTo = onboardingReturn ? "/onboarding" : undefined;

    const makeErrorRedirect = (code: GitHubErrorCode): NextResponse => {
      const response = NextResponse.redirect(
        getErrorRedirectUrl(code, onboardingReturnTo)
      );
      clearGithubOAuthCookies(response);
      return response;
    };

    const { userId, orgId, getToken } = await auth();

    if (!(userId && orgId)) {
      log.warn("[github/callback] Not authenticated");
      return makeErrorRedirect(GITHUB_ERROR_CODES.NOT_AUTHENTICATED);
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
      return makeErrorRedirect(GITHUB_ERROR_CODES.OAUTH_FAILED);
    }

    // Get code, state, and optional installation_id from URL
    // installation_id is present in the /installations/new flow but absent
    // in the standard OAuth authorize flow (when app is already installed)
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

    if (!(code && state)) {
      log.warn("[github/callback] Missing required params", {
        hasCode: !!code,
        hasState: !!state,
        hasInstallationId: !!installationId,
      });
      return makeErrorRedirect(GITHUB_ERROR_CODES.MISSING_PARAMS);
    }

    // Verify state (CSRF protection)
    const storedState = cookieStore.get(GITHUB_OAUTH_STATE_COOKIE)?.value;

    if (!storedState) {
      log.warn("[github/callback] Missing stored state");
      return makeErrorRedirect(GITHUB_ERROR_CODES.INVALID_STATE);
    }

    // Timing-safe state comparison to prevent CSRF
    if (!timingSafeCompare(storedState, state)) {
      log.warn("[github/callback] State mismatch");
      return makeErrorRedirect(GITHUB_ERROR_CODES.INVALID_STATE);
    }

    const returnTo =
      verifyGitHubOAuthReturnToCookie({
        cookieValue: cookieStore.get(GITHUB_OAUTH_RETURN_TO_COOKIE)?.value,
        now: Date.now(),
        state,
      }) ?? onboardingReturnTo;

    // Send code + installationId to API for token exchange
    // Token exchange happens in API to keep client_secret there
    const clerkToken = await getToken();
    const apiResponse = await fetch(
      `${resolveApiOrigin(request)}/integrations/github/connect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clerkToken}`,
        },
        body: JSON.stringify({
          code,
          ...(installationId && { installationId }),
        }),
      }
    );

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      // Redact sensitive data from error logs - only log status and truncated message
      log.error("[github/callback] Failed to connect GitHub", {
        status: apiResponse.status,
        error:
          apiResponse.status >= 500
            ? "Internal server error"
            : errorBody.slice(0, 200),
      });
      const errorResponse = NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.CONNECTION_FAILED, returnTo)
      );
      clearGithubOAuthCookies(errorResponse);
      return errorResponse;
    }

    // PLN-634: detect the different-account reconnect path so we can redirect
    // to the settings page with a confirmation prompt rather than silently
    // wiping repository configuration.
    const body = (await apiResponse.json()) as ConnectGitHubResponseBody;
    if (body.data && "status" in body.data) {
      log.info("[github/callback] Different-account reconnect detected", {
        userId,
        orgId,
        priorAccountId: body.data.priorAccount.accountId,
        newAccountId: body.data.newAccount.accountId,
      });
      const response = NextResponse.redirect(
        getRequiresConfirmationRedirectUrl({
          priorAccountId: body.data.priorAccount.accountId,
          priorAccountLogin: body.data.priorAccount.accountLogin,
          newAccountId: body.data.newAccount.accountId,
          newAccountLogin: body.data.newAccount.accountLogin,
          newInstallationId: body.data.newInstallationId,
        })
      );
      clearGithubOAuthCookies(response);
      return response;
    }

    log.info("[github/callback] GitHub connected successfully", {
      userId,
      orgId,
    });

    // Clear cookies and redirect using response object pattern (Next.js App Router best practice)
    const response = NextResponse.redirect(getSuccessRedirectUrl(returnTo));
    clearGithubOAuthCookies(response);
    return response;
  } catch (error) {
    log.error("[github/callback] Failed to complete OAuth", { error });
    const response = NextResponse.redirect(
      getErrorRedirectUrl(GITHUB_ERROR_CODES.OAUTH_FAILED)
    );
    clearGithubOAuthCookies(response);
    return response;
  }
}

function clearGithubOAuthCookies(response: NextResponse): void {
  response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, "", { maxAge: 0, path: "/" });
  response.cookies.set("onboarding_return", "", { maxAge: 0, path: "/" });
  response.cookies.set(GITHUB_OAUTH_RETURN_TO_COOKIE, "", {
    maxAge: 0,
    path: GITHUB_OAUTH_RETURN_TO_COOKIE_PATH,
  });
}
