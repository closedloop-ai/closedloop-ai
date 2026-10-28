import type { ConnectGitHubResponse } from "@repo/api/src/types/github";
import { GitHubConnectErrorCode } from "@repo/api/src/types/github-clerk-link";
import {
  GITHUB_ERROR_CODES,
  type GitHubErrorCode,
} from "@repo/api/src/types/github-status";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveApiOrigin } from "@/lib/api-origin";
import {
  GITHUB_OAUTH_RETURN_TO_COOKIE,
  GITHUB_OAUTH_RETURN_TO_COOKIE_PATH,
  GITHUB_OAUTH_STATE_COOKIE,
  getErrorRedirectUrl,
  getGitHubLinkRedirectUrl,
  getRequiresConfirmationRedirectUrl,
  getSuccessRedirectUrl,
  timingSafeCompare,
  verifyGitHubOAuthReturnToCookie,
} from "../github-utils";

type ConnectGitHubResponseBody = { data?: ConnectGitHubResponse };
type ConnectGitHubFailureBody = { code?: string };

/**
 * GET /api/integrations/github/callback
 *
 * Handles the return from the GitHub App INSTALL flow (`/installations/new`).
 * Validates CSRF state, then sends the installation ID to the API to claim
 * it for the org (PLN-1742 M5 — there is no OAuth code exchange anymore; the
 * API verifies the installation through the App's own JWT, and user
 * credentials come exclusively from Clerk linking).
 *
 * GitHub may still append an OAuth `code` while "Request user authorization
 * during installation" stays enabled on the App — it is ignored here.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // Read cookies before any branch can return so every callback clears stale
    // OAuth state and Branch View return cookies consistently.
    const cookieStore = await cookies();

    const makeErrorRedirect = (code: GitHubErrorCode): NextResponse => {
      const response = NextResponse.redirect(getErrorRedirectUrl(code));
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

    const state = searchParams.get("state");
    const installationId = searchParams.get("installation_id");

    log.info("[github/callback] Received callback params", {
      hasState: !!state,
      hasInstallationId: !!installationId,
      installationId,
    });

    if (!(installationId && state)) {
      log.warn("[github/callback] Missing required params", {
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

    // `?? undefined` because the verifier reports "no valid return cookie" as
    // `null` and the redirect helpers take an optional string.
    const returnTo =
      verifyGitHubOAuthReturnToCookie({
        cookieValue: cookieStore.get(GITHUB_OAUTH_RETURN_TO_COOKIE)?.value,
        now: Date.now(),
        state,
      }) ?? undefined;

    // Send the installation to the API to claim it for the org.
    const clerkToken = await getToken();
    const apiResponse = await fetch(
      `${resolveApiOrigin(request)}/integrations/github/connect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clerkToken}`,
        },
        body: JSON.stringify({ installationId }),
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
      // PLN-1742 M5: the App is installed by the time we get here, so a
      // refusal the caller can actually fix must route to the fix. Linking
      // is that fix, and the linking page finishes this same claim, so an
      // install-before-connect user lands connected instead of on a generic
      // "try again" they cannot act on.
      const failureCode = readConnectFailureCode(errorBody);
      const redirectUrl =
        failureCode === GitHubConnectErrorCode.LinkRequired
          ? getGitHubLinkRedirectUrl(installationId, returnTo)
          : getErrorRedirectUrl(GITHUB_ERROR_CODES.CONNECTION_FAILED, returnTo);
      const errorResponse = NextResponse.redirect(redirectUrl);
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

/**
 * The failure body is the API's `ApiResult` shape, but a proxy or a 5xx can
 * put anything on the wire — an unreadable body simply carries no code.
 */
function readConnectFailureCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as ConnectGitHubFailureBody;
    return typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

function clearGithubOAuthCookies(response: NextResponse): void {
  response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, "", { maxAge: 0, path: "/" });
  response.cookies.set(GITHUB_OAUTH_RETURN_TO_COOKIE, "", {
    maxAge: 0,
    path: GITHUB_OAUTH_RETURN_TO_COOKIE_PATH,
  });
}
