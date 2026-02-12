import { timingSafeEqual } from "node:crypto";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import {
  GOOGLE_OAUTH_ERRORS,
  GOOGLE_STATE_COOKIE,
  GOOGLE_VERIFIER_COOKIE,
  getGoogleCallbackUrl,
} from "../google-utils";

/**
 * GET /api/integrations/google/callback
 *
 * Handles the OAuth callback from Google.
 * Validates state, then sends code + PKCE verifier to API for token exchange.
 * Token exchange happens in the API to keep client_secret there.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { userId, orgId, getToken } = await auth();

    if (!(userId && orgId)) {
      log.warn("[google/callback] Not authenticated");
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.NOT_AUTHENTICATED)}`
      );
    }

    const { searchParams } = new URL(request.url);

    // Check for OAuth errors from Google
    const error = searchParams.get("error");
    if (error) {
      const errorDescription = searchParams.get("error_description");
      log.warn("[google/callback] OAuth error from Google", {
        error,
        errorDescription,
      });
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.OAUTH_FAILED)}`
      );
    }

    // Get code and state from URL
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!(code && state)) {
      log.warn("[google/callback] Missing code or state");
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.MISSING_PARAMS)}`
      );
    }

    // Verify state (CSRF protection)
    const cookieStore = await cookies();
    const storedState = cookieStore.get(GOOGLE_STATE_COOKIE)?.value;
    const codeVerifier = cookieStore.get(GOOGLE_VERIFIER_COOKIE)?.value;

    if (!storedState) {
      log.warn("[google/callback] Missing stored state");
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.INVALID_STATE)}`
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
      log.warn("[google/callback] State mismatch");
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.INVALID_STATE)}`
      );
    }

    if (!codeVerifier) {
      log.warn("[google/callback] Missing PKCE verifier");
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.MISSING_PARAMS)}`
      );
    }

    // Send code + verifier + redirectUri to API for token exchange.
    // Token exchange happens in API to keep client_secret there.
    // We send the redirectUri so the API uses the exact same value that was
    // sent to Google during authorization (avoids mismatch between app/API builds).
    const redirectUri = getGoogleCallbackUrl();
    const clerkToken = await getToken();
    const apiResponse = await fetch(
      `${env.NEXT_PUBLIC_API_URL}/integrations/google/connect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clerkToken}`,
        },
        body: JSON.stringify({
          code,
          codeVerifier,
          redirectUri,
        }),
      }
    );

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      // Redact sensitive data from error logs - only log status and truncated message
      log.error("[google/callback] Failed to connect Google", {
        status: apiResponse.status,
        error:
          apiResponse.status >= 500
            ? "Internal server error"
            : errorBody.substring(0, 200),
      });
      return NextResponse.redirect(
        `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.TOKEN_EXCHANGE_FAILED)}`
      );
    }

    log.info("[google/callback] Google connected successfully", {
      userId,
      orgId,
    });

    // Clear cookies and redirect using response object pattern (Next.js App Router best practice)
    const response = NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=success`
    );
    response.cookies.delete(GOOGLE_STATE_COOKIE);
    response.cookies.delete(GOOGLE_VERIFIER_COOKIE);
    return response;
  } catch (error) {
    log.error("[google/callback] Failed to complete OAuth", { error });
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/settings?tab=integrations&google=error&message=${encodeURIComponent(GOOGLE_OAUTH_ERRORS.OAUTH_FAILED)}`
    );
  }
}
