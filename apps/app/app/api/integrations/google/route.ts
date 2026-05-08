import { auth } from "@repo/auth/server";
import { generatePKCE } from "@repo/google";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/env";
import {
  buildGoogleAuthUrl,
  GOOGLE_OAUTH_ERRORS,
  GOOGLE_STATE_COOKIE,
  GOOGLE_VERIFIER_COOKIE,
  getGoogleCallbackUrl,
} from "./google-utils";

/**
 * GET /api/integrations/google
 *
 * Initiates Google OAuth flow by redirecting to Google's authorization page.
 * Uses Clerk auth directly (no cross-domain workaround needed).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const { userId, orgId } = await auth();

    if (!(userId && orgId)) {
      log.warn("[google/oauth] Not authenticated");
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.NOT_AUTHENTICATED)}`
      );
    }

    // Check if Google is configured
    if (!env.GOOGLE_CLIENT_ID) {
      log.warn("[google/oauth] Google not configured");
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.NOT_CONFIGURED)}`
      );
    }

    // Generate CSRF state and PKCE challenge
    const state = crypto.randomUUID();
    const pkce = await generatePKCE();

    // Build callback URL (points to this app)
    const callbackUrl = getGoogleCallbackUrl();

    // Store state and verifier in secure cookies
    const cookieStore = await cookies();
    const isProduction = process.env.NODE_ENV === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax" as const,
      maxAge: 60 * 10, // 10 minutes
      path: "/",
    };

    cookieStore.set(GOOGLE_STATE_COOKIE, state, cookieOptions);
    cookieStore.set(GOOGLE_VERIFIER_COOKIE, pkce.codeVerifier, cookieOptions);

    // Build Google OAuth URL
    const googleUrl = buildGoogleAuthUrl(
      state,
      pkce.codeChallenge,
      callbackUrl,
      env.GOOGLE_CLIENT_ID
    );

    log.info("[google/oauth] Redirecting to Google OAuth", {
      userId,
      orgId,
    });

    return NextResponse.redirect(googleUrl);
  } catch (error) {
    log.error("[google/oauth] Failed to initiate OAuth", { error });
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.OAUTH_FAILED)}`
    );
  }
}
