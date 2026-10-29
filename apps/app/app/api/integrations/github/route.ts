import { GITHUB_CLERK_LINK_PATH } from "@repo/api/src/types/github-clerk-link";
import { GITHUB_ERROR_CODES } from "@repo/api/src/types/github-status";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { getCanonicalBranchViewReturnPath } from "./github-return-path";
import {
  createGitHubOAuthReturnToCookie,
  GITHUB_OAUTH_RETURN_TO_COOKIE,
  GITHUB_OAUTH_RETURN_TO_COOKIE_PATH,
  GITHUB_OAUTH_STATE_COOKIE,
  getErrorRedirectUrl,
} from "./github-utils";

/**
 * GET /api/integrations/github
 *
 * GitHub App INSTALL entry point: `?install=true` → `/installations/new`,
 * with CSRF state the callback verifies before claiming the installation.
 *
 * PLN-1742 M5 retired the in-house OAuth authorize flow. Any non-install
 * request is a stale client (an old desktop build's connect opener, a
 * bookmark, a pre-M5 web bundle) and is redirected to the Clerk linking
 * page with its raw `returnTo` preserved — the page canonicalizes it
 * server-side exactly like this route used to.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const forceInstall = request.nextUrl.searchParams.get("install") === "true";
    if (!forceInstall) {
      const linkUrl = new URL(GITHUB_CLERK_LINK_PATH, env.NEXT_PUBLIC_APP_URL);
      const rawReturnTo = request.nextUrl.searchParams.get("returnTo");
      if (rawReturnTo) {
        linkUrl.searchParams.set("returnTo", rawReturnTo);
      }
      return NextResponse.redirect(linkUrl);
    }

    const { userId, orgId, orgSlug } = await auth();

    if (!(userId && orgId)) {
      log.warn("[github/oauth] Not authenticated");
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.NOT_AUTHENTICATED)
      );
    }

    const appSlug = env.NEXT_PUBLIC_GITHUB_APP_SLUG;

    if (!appSlug) {
      log.warn("[github/oauth] Install flow requested but slug not configured");
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
    const returnTo = getCanonicalBranchViewReturnPath(
      request.nextUrl.searchParams.get("returnTo"),
      { orgSlug }
    );
    if (returnTo) {
      cookieStore.set(
        GITHUB_OAUTH_RETURN_TO_COOKIE,
        createGitHubOAuthReturnToCookie({
          issuedAt: Date.now(),
          returnTo,
          state,
        }),
        { ...cookieOptions, path: GITHUB_OAUTH_RETURN_TO_COOKIE_PATH }
      );
    }

    // Installation flow: /installations/new only works for NEW installations
    // -- if the app is already installed, GitHub redirects to the settings
    // page instead of completing the setup redirect.
    const githubUrl = `https://github.com/apps/${appSlug}/installations/new?state=${state}`;

    log.info("[github/oauth] Redirecting to GitHub App installation", {
      userId,
      orgId,
    });

    return NextResponse.redirect(githubUrl);
  } catch (error) {
    log.error("[github/oauth] Failed to initiate GitHub install flow", {
      error,
    });
    return NextResponse.redirect(
      getErrorRedirectUrl(GITHUB_ERROR_CODES.OAUTH_FAILED)
    );
  }
}
