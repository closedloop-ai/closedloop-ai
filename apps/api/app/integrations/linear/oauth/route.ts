import { generatePKCE, getOAuthUrl, isLinearConfigured } from "@repo/linear";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getOAuthErrorRedirectUrl,
  LINEAR_OAUTH_STATE_COOKIE,
  LINEAR_PKCE_VERIFIER_COOKIE,
} from "./constants";
import { getAuthenticatedOrganization } from "./helpers";

/**
 * GET /integrations/linear/oauth
 *
 * Initiates Linear OAuth flow by redirecting to Linear's authorization page.
 * Sets a state cookie for CSRF protection and PKCE verifier.
 *
 * Note: This route does NOT use withAuth middleware because:
 * 1. It must return HTTP redirects (not JSON responses)
 * 2. It needs to set cookies before redirecting to Linear's OAuth page
 * 3. Authentication is verified via Clerk session (using auth() directly)
 */
export async function GET(): Promise<NextResponse> {
  try {
    // Authenticate and get organization
    const orgResult = await getAuthenticatedOrganization("[linear/oauth]");
    if (!orgResult.success) {
      return orgResult.redirect;
    }

    const { organization, clerkUserId } = orgResult;

    if (!isLinearConfigured()) {
      return NextResponse.redirect(
        getOAuthErrorRedirectUrl("Linear not configured")
      );
    }

    // Generate a random state parameter for CSRF protection
    const state = crypto.randomUUID();

    // Generate PKCE challenge for enhanced OAuth security
    const pkce = await generatePKCE();

    // Store state and PKCE verifier in secure, HTTP-only cookies
    const cookieStore = await cookies();
    const isProduction = process.env.NODE_ENV === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction, // Use secure cookies in production, allow HTTP in development
      sameSite: "lax" as const,
      maxAge: 60 * 10, // 10 minutes
      path: "/",
      domain: isProduction ? undefined : "localhost", // Explicit domain for localhost
    };

    cookieStore.set(LINEAR_OAUTH_STATE_COOKIE, state, cookieOptions);
    cookieStore.set(
      LINEAR_PKCE_VERIFIER_COOKIE,
      pkce.codeVerifier,
      cookieOptions
    );

    const url = getOAuthUrl(state, pkce);

    log.info("[linear/oauth] Redirecting to Linear OAuth", {
      clerkUserId,
      organizationId: organization.id,
    });

    return NextResponse.redirect(url);
  } catch (error) {
    log.error("[linear/oauth] Failed to initiate OAuth", {
      error: parseError(error),
    });
    return NextResponse.redirect(
      getOAuthErrorRedirectUrl("Failed to start OAuth")
    );
  }
}
