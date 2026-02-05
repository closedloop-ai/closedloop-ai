import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/env";
import {
  GITHUB_ERROR_CODES,
  GITHUB_OAUTH_STATE_COOKIE,
  getErrorRedirectUrl,
} from "./github-utils";

/**
 * GET /api/integrations/github
 *
 * Initiates GitHub App installation flow with OAuth authorization.
 * Uses GitHub's "OAuth during installation" golden standard pattern.
 *
 * Flow:
 * 1. Generate CSRF state token
 * 2. Store state in HTTP-only cookie (10 min expiry)
 * 3. Redirect to GitHub App install page with state param
 * 4. GitHub combines installation + OAuth authorization
 * 5. GitHub redirects to callback with code + installation_id + state
 *
 * Note: We don't use PKCE here because the GitHub App installation URL doesn't
 * support passing code_challenge. PKCE would only work with the standard OAuth
 * authorization URL, not the App installation flow.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const { userId, orgId } = await auth();

    if (!(userId && orgId)) {
      log.warn("[github/oauth] Not authenticated");
      return NextResponse.redirect(
        getErrorRedirectUrl(GITHUB_ERROR_CODES.NOT_AUTHENTICATED)
      );
    }

    // Check if GitHub App is configured
    if (!env.NEXT_PUBLIC_GITHUB_APP_SLUG) {
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

    // Build GitHub App installation URL with state param
    // GitHub's "OAuth during installation" mode will combine authorization with installation
    // and redirect to callback with code + installation_id + state
    const githubUrl = `https://github.com/apps/${env.NEXT_PUBLIC_GITHUB_APP_SLUG}/installations/new?state=${state}`;

    log.info("[github/oauth] Redirecting to GitHub App installation", {
      userId,
      orgId,
    });

    return NextResponse.redirect(githubUrl);
  } catch (error) {
    log.error("[github/oauth] Failed to initiate GitHub App installation", {
      error,
    });
    return NextResponse.redirect(
      getErrorRedirectUrl(GITHUB_ERROR_CODES.OAUTH_FAILED)
    );
  }
}
