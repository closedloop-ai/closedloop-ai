import { auth } from "@repo/auth/server";
import { generatePKCE } from "@repo/linear";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/env";
import {
  getErrorRedirectUrl,
  getLinearCallbackUrl,
  LINEAR_ERROR_CODES,
  LINEAR_OAUTH_STATE_COOKIE,
  LINEAR_OAUTH_URL,
  LINEAR_PKCE_VERIFIER_COOKIE,
} from "./linear-utils";

/**
 * GET /api/integrations/linear
 *
 * Initiates Linear OAuth flow by redirecting to Linear's authorization page.
 * Uses Clerk auth directly (no cross-domain workaround needed).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const { userId, orgId } = await auth();

    if (!(userId && orgId)) {
      log.warn("[linear/oauth] Not authenticated");
      return NextResponse.redirect(
        getErrorRedirectUrl(LINEAR_ERROR_CODES.NOT_AUTHENTICATED)
      );
    }

    // Check if Linear is configured
    if (!env.LINEAR_CLIENT_ID) {
      log.warn("[linear/oauth] Linear not configured");
      return NextResponse.redirect(
        getErrorRedirectUrl(LINEAR_ERROR_CODES.NOT_CONFIGURED)
      );
    }

    // Generate CSRF state and PKCE challenge
    const state = crypto.randomUUID();
    const pkce = await generatePKCE();

    // Build callback URL (points to this app, not the API)
    const callbackUrl = getLinearCallbackUrl();

    // Store state and PKCE in secure cookies
    const cookieStore = await cookies();
    const isProduction = process.env.NODE_ENV === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax" as const,
      maxAge: 60 * 10, // 10 minutes
      path: "/",
    };

    cookieStore.set(LINEAR_OAUTH_STATE_COOKIE, state, cookieOptions);
    cookieStore.set(
      LINEAR_PKCE_VERIFIER_COOKIE,
      pkce.codeVerifier,
      cookieOptions
    );

    // Build Linear OAuth URL
    const params = new URLSearchParams({
      client_id: env.LINEAR_CLIENT_ID,
      redirect_uri: callbackUrl,
      response_type: "code",
      scope: "read,write,issues:create",
      state,
      prompt: "consent",
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
    });

    const linearUrl = `${LINEAR_OAUTH_URL}?${params.toString()}`;

    log.info("[linear/oauth] Redirecting to Linear OAuth", {
      userId,
      orgId,
    });

    return NextResponse.redirect(linearUrl);
  } catch (error) {
    log.error("[linear/oauth] Failed to initiate OAuth", { error });
    return NextResponse.redirect(
      getErrorRedirectUrl(LINEAR_ERROR_CODES.OAUTH_FAILED)
    );
  }
}
