import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import {
  GITHUB_ERROR_CODES,
  GITHUB_OAUTH_STATE_COOKIE,
  getErrorRedirectUrl,
  getGitHubCallbackUrl,
} from "./github-utils";

/**
 * GET /api/integrations/github
 *
 * Initiates GitHub OAuth authorization or App installation flow.
 *
 * Two modes:
 * - Standard OAuth (default): Uses /login/oauth/authorize — works when the app
 *   is already installed. Requires GITHUB_APP_CLIENT_ID.
 * - Installation flow (?install=true): Uses /installations/new — combines
 *   installation + OAuth for first-time setup. Requires NEXT_PUBLIC_GITHUB_APP_SLUG.
 *
 * Falls back to installation flow when only NEXT_PUBLIC_GITHUB_APP_SLUG is set
 * (backward compatible with deployments that haven't added the client ID yet).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { userId, orgId } = await auth();

    if (!(userId && orgId)) {
      log.warn("[github/oauth] Not authenticated");
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.NOT_AUTHENTICATED)
      );
    }

    const clientId = env.GITHUB_APP_CLIENT_ID;
    const appSlug = env.NEXT_PUBLIC_GITHUB_APP_SLUG;

    if (!(clientId || appSlug)) {
      log.warn("[github/oauth] GitHub App not configured");
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.NOT_CONFIGURED)
      );
    }

    // Generate CSRF state token
    const state = crypto.randomUUID();

    // Store state in secure cookie
    const cookieStore = await cookies();
    const isProduction = process.env.NODE_ENV === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax" as const,
      maxAge: 60 * 10, // 10 minutes
      path: "/",
    };

    cookieStore.set(GITHUB_OAUTH_STATE_COOKIE, state, cookieOptions);

    // Determine which flow to use:
    // 1. ?install=true forces the /installations/new flow (first-time setup)
    // 2. Default: standard OAuth URL if client_id is available (works for existing installs)
    // 3. Fallback: /installations/new if only slug is configured (backward compat)
    const forceInstall = request.nextUrl.searchParams.get("install") === "true";

    // Explicit error when install is requested but slug is not configured
    if (forceInstall && !appSlug) {
      log.warn("[github/oauth] Install flow requested but slug not configured");
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.NOT_CONFIGURED)
      );
    }

    const useInstallFlow = forceInstall ? !!appSlug : !clientId && !!appSlug;

    if (useInstallFlow) {
      // Installation flow: combines GitHub App install + OAuth in one step.
      // Only works for NEW installations -- if the app is already installed,
      // GitHub redirects to the settings page instead of completing OAuth.
      const githubUrl = `https://github.com/apps/${appSlug}/installations/new?state=${state}`;

      log.info("[github/oauth] Redirecting to GitHub App installation", {
        userId,
        orgId,
      });

      return NextResponse.redirect(githubUrl);
    }

    // Standard OAuth: always triggers authorization regardless of install status.
    // clientId is guaranteed non-null here: useInstallFlow is false means clientId is truthy
    // (the only way useInstallFlow=false with !clientId is if !appSlug too, caught by the
    // not-configured check above).
    if (!clientId) {
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.NOT_CONFIGURED)
      );
    }

    const githubUrl = new URL("https://github.com/login/oauth/authorize");
    githubUrl.searchParams.set("client_id", clientId);
    githubUrl.searchParams.set("redirect_uri", getGitHubCallbackUrl());
    githubUrl.searchParams.set("state", state);

    log.info("[github/oauth] Redirecting to GitHub OAuth authorization", {
      userId,
      orgId,
    });

    return NextResponse.redirect(githubUrl.toString());
  } catch (error) {
    log.error("[github/oauth] Failed to initiate GitHub OAuth flow", {
      error,
    });
    return NextResponse.redirect(
      getErrorRedirectUrl(GITHUB_ERROR_CODES.OAUTH_FAILED)
    );
  }
}
