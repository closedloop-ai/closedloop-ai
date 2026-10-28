import "server-only";

import {
  BROWSER_SESSION_OFFSET_MAX,
  BROWSER_SESSION_PAGE_LIMIT_DEFAULT,
  BROWSER_SESSION_PAGE_LIMIT_MAX,
  type BrowserSessionListResponse,
} from "@repo/api/src/types/browser-session";
import { clampPageLimit } from "@repo/api/src/types/page-limit-bounds";
import { Result, Status } from "@repo/api/src/types/result";
import { clerkService } from "@/lib/auth/clerk-service";
import { clampPageOffset } from "@/lib/validators/pagination";

/**
 * Why a revoke was refused.
 *
 * `Conflict` is the caller's own session, `NotFound` covers both an unknown
 * session and one owned by somebody else. A provider failure is NOT a member:
 * it throws, so the route answers 503 and "we could not reach the provider"
 * stays distinct from every decision here.
 */
export type BrowserSessionRevokeError =
  | typeof Status.Conflict
  | typeof Status.NotFound;

export const browserSessionService = {
  /**
   * One page of the caller's own browser sessions.
   *
   * `clerkSessionId` is undefined on a transport with no Clerk browser session
   * (the Desktop). That makes every row non-current, which is truthful, and
   * `currentSessionKnown: false` is what stops a consumer reading it as "none
   * of these is the one you are using".
   */
  async list(params: {
    clerkUserId: string;
    clerkSessionId: string | undefined;
    /** Undefined when the caller did not ask; the clamp supplies the default. */
    limit: number | undefined;
    offset: number | undefined;
    /** The requesting browser's `User-Agent` (ISS-12135). */
    userAgent?: string;
  }): Promise<BrowserSessionListResponse> {
    const limit = clampPageLimit(params.limit, {
      defaultLimit: BROWSER_SESSION_PAGE_LIMIT_DEFAULT,
      maxLimit: BROWSER_SESSION_PAGE_LIMIT_MAX,
    });
    const offset = clampPageOffset(params.offset, BROWSER_SESSION_OFFSET_MAX);

    const page = await clerkService.listUserBrowserSessions({
      userId: params.clerkUserId,
      limit,
      offset,
      userAgent: params.userAgent,
    });

    return {
      sessions: page.sessions.map((session) => ({
        ...session,
        isCurrentSession:
          params.clerkSessionId !== undefined &&
          session.id === params.clerkSessionId,
      })),
      totalCount: page.totalCount,
      limit,
      offset,
      currentSessionKnown: params.clerkSessionId !== undefined,
    };
  },

  /**
   * Revoke one of the caller's own sessions.
   *
   * The order is the security property, not a style choice:
   *
   * 1. Refuse the caller's own session FIRST, so a refused request never
   *    reaches a provider lookup and cannot leak timing or existence.
   * 2. Unknown session and someone else's session both settle `not_found`.
   *    Answering "forbidden" for the second would confirm that a guessed id is
   *    real and belongs to another user, which is the enumeration this refuses.
   * 3. Only then revoke.
   */
  async revoke(params: {
    clerkUserId: string;
    clerkSessionId: string | undefined;
    sessionId: string;
  }): Promise<Result<true, BrowserSessionRevokeError>> {
    if (
      params.clerkSessionId !== undefined &&
      params.sessionId === params.clerkSessionId
    ) {
      return Result.err(Status.Conflict);
    }

    const owner = await clerkService.getBrowserSessionOwner(params.sessionId);

    if (owner === null || owner.userId !== params.clerkUserId) {
      return Result.err(Status.NotFound);
    }

    await clerkService.revokeBrowserSession(params.sessionId);
    return Result.ok(true);
  },
};
