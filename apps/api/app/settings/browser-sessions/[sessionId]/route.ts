import {
  BrowserSessionErrorCode,
  type BrowserSessionRevokeResponse,
} from "@repo/api/src/types/browser-session";
import { Status } from "@repo/api/src/types/result";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  conflictResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { browserSessionService } from "../../browser-session-service";

/**
 * The provider's session-id shape. Checked before the id is used as a path
 * segment in a secret-key-authenticated provider request (ISS-8880's pattern):
 * an unvalidated segment reaches URL resolution, and one the provider cannot
 * answer surfaces as a 503 plus an error log that any authenticated caller
 * could drive on demand.
 *
 * The LENGTH bound is the load-bearing half. Measured against the provider on
 * 2026-09-04: a `sess_` id of 2k, 8k, and 30k characters all came back as a
 * clean 404, but at 100k the request failed at the transport layer with no
 * response at all — which is correctly NOT a 404, so it propagates and becomes
 * that drivable 503. Real ids are 32 characters (`sess_` plus 27), so 20–64
 * holds every genuine one with room for the provider to change its mind.
 */
const CLERK_SESSION_ID_PATTERN = /^sess_[A-Za-z0-9]{20,64}$/;

/**
 * DELETE /settings/browser-sessions/[sessionId]
 *
 * Sign one of the caller's OTHER browser sessions out (ISS-9085). Authority is
 * the authenticated caller; a supplied user or organization id is never
 * accepted as one.
 *
 * See `browserSessionService.revoke` for why the checks run in the order they
 * do — that ordering is the security property.
 */
export const DELETE = withAnyAuth<
  BrowserSessionRevokeResponse,
  "/settings/browser-sessions/[sessionId]"
>(async ({ clerkUserId, clerkSessionId, authMethod }, _request, params) => {
  if (authMethod === "api_key") {
    return forbiddenResponse();
  }

  const { sessionId } = await params;
  // A malformed id gets the SAME answer as an unknown one, for the same reason
  // a foreign one does: any distinguishable response is a probe oracle.
  if (!(sessionId && CLERK_SESSION_ID_PATTERN.test(sessionId))) {
    return notFoundResponse("Session", {
      code: BrowserSessionErrorCode.SessionNotFound,
    });
  }

  try {
    const outcome = await browserSessionService.revoke({
      clerkUserId,
      clerkSessionId,
      sessionId,
    });

    if (!outcome.ok) {
      if (outcome.error === Status.Conflict) {
        return conflictResponse(
          "The current session cannot be revoked here. Use sign out.",
          { code: BrowserSessionErrorCode.CurrentSessionNotRevocable }
        );
      }
      // Deliberately the same answer for "no such session" and "somebody
      // else's session". A 403 for the second would confirm a guessed id.
      return notFoundResponse("Session", {
        code: BrowserSessionErrorCode.SessionNotFound,
      });
    }

    return successResponse({ revoked: true as const });
  } catch (error) {
    return errorResponse("Failed to revoke browser session", error, 503, {
      code: BrowserSessionErrorCode.ProviderUnavailable,
    });
  }
});
