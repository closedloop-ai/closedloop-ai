import "server-only";

import { SpanErrorSource } from "@closedloop-ai/telemetry-contract/span";
import { withPostHogRequestContext } from "@repo/analytics/node";
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  AuthErrorCode,
  ORG_UNVERIFIABLE_MESSAGE,
} from "@repo/api/src/types/auth-error";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/user";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { runWithFeatureFlagOverrides } from "../feature-flags/feature-flag-request-scope-auth";
import { drainOrgAdminDenials } from "../observability/admin-denial-telemetry";
import { readResponseErrorCode } from "../observability/request-error-code";
import { readRouteParams } from "../observability/request-route-path";
import {
  recordRequestAuthenticatedIdentity,
  recordRequestClientAttribution,
  recordRequestErrorCause,
  runWithRequestSpanAttribution,
} from "../observability/request-span-attribution";
import {
  forbiddenResponse,
  logRequestCompleted,
  serviceUnavailableResponse,
  unauthorizedResponse,
} from "../route-utils";
import type { ArtifactEditAuthMethod } from "./artifact-edit-auth-method";
import { findOrCreateUser } from "./find-or-create-user";
import { resolveOrgHeader } from "./resolve-org-header";

/**
 * Next.js route context - matches generated type from @/.next/types/routes
 * In App Router, all route params are single strings (not arrays)
 */
export type RouteContext<_TRoute extends string = string> = {
  params: Promise<Record<string, string>>;
};

/**
 * Context passed to authenticated route handlers.
 */
export type AuthContext = {
  user: User;
  clerkUserId: string;
  clerkOrgId: string;
  orgRole?: string;
  authMethod: ArtifactEditAuthMethod;
  /**
   * The caller's Clerk browser-session id (ISS-9085).
   *
   * Present only on `authMethod: "session"`. Absent by construction on the
   * api-key and desktop-session wrappers, whose credentials are not Clerk
   * browser sessions — the Desktop's `sid` is a refresh-token-family id. A
   * consumer must read absence as "this transport has no browser session",
   * never as "no session is current".
   */
  clerkSessionId?: string;
  /** Internal id of the verified API key, when API-key auth established identity. */
  apiKeyId?: string;
  /** Internal id of the verified Desktop session, when Desktop auth established identity. */
  desktopSessionId?: string;
  apiKeyScopes?: ApiKeyScope[];
};

export type AuthenticatedJsonResponse<TResponse> = NextResponse<
  ApiResult<TResponse>
>;

/**
 * Route handler function type using Next.js RouteContext.
 *
 * @template TResponse - The response data type
 * @template TRoute - The route literal (e.g., '/projects/[id]') for type-safe params
 */
export type AuthenticatedHandler<TResponse, TRoute extends string = string> = (
  context: AuthContext,
  request: NextRequest,
  params: RouteContext<TRoute>["params"]
) => Promise<AuthenticatedJsonResponse<TResponse>>;

/**
 * Higher-order function that wraps route handlers with authentication.
 *
 * Ensures:
 * - User is authenticated via Clerk
 * - Clerk userId and orgId are present
 * - User exists in database (creates if not)
 * - Organization exists in database (creates if not)
 *
 * @example
 * // Simple handler (no params)
 * export const GET = withAuth<Project[], '/projects'>(async ({ user }) => {
 *   return successResponse({ userId: user.id });
 * });
 *
 * @example
 * // Handler with request body
 * export const POST = withAuth<Project, '/projects'>(async ({ user }, request) => {
 *   const body = await request.json();
 *   // ...
 * });
 *
 * @example
 * // Handler with route params (type-safe)
 * export const GET = withAuth<Project, '/projects/[id]'>(async ({ user }, request, params) => {
 *   const { id } = await params; // type-safe: params.id is string
 *   // ...
 * });
 */
export function withAuth<TResponse, TRoute extends string = string>(
  handler: AuthenticatedHandler<TResponse, TRoute>
): (
  request: NextRequest,
  context: RouteContext<TRoute>
) => Promise<AuthenticatedJsonResponse<TResponse>> {
  return (
    request: NextRequest,
    routeContext: RouteContext<TRoute>
  ): Promise<AuthenticatedJsonResponse<TResponse>> =>
    // ISS-7217/ISS-7221: scope wraps the whole closure, including the `finally`
    // that emits the span. See `with-api-key-auth.ts` for the full note.
    runWithRequestSpanAttribution(async () => {
      const startMs = globalThis.performance.now();
      let response: AuthenticatedJsonResponse<TResponse> | undefined;
      try {
        // ISS-8749 / ISS-11431: the caller's own account of which Desktop
        // install and build this is, recorded before any auth decision so a
        // 401 burst names the installs it rejected. Attested, never trusted: it
        // reaches the span and nothing else.
        recordRequestClientAttribution(request.headers);
        const {
          userId: clerkUserId,
          orgId: clerkOrgId,
          orgRole,
          sessionId: clerkSessionId,
        } = await auth();

        if (!(clerkUserId && clerkOrgId)) {
          response = unauthorizedResponse();
          return response;
        }

        const orgResolution = await resolveOrgHeader(
          request,
          clerkUserId,
          clerkOrgId,
          orgRole ?? undefined
        );
        if (orgResolution.kind === "forbidden") {
          // Coded, because this 403 is session-level, not resource-level
          // (ISS-5095). `resolveOrgHeader` answered "no" here: Clerk was reached
          // and reported that this caller is not a member of the org the request
          // named — an org-switch race, or a membership revoked mid-session. A
          // lookup that FAILED is deliberately NOT this branch (ISS-5118); it is
          // `unverifiable`, handled six lines below, because nobody decided
          // anything in that case. Since every authenticated request carries the
          // org header, either condition fails every query at once. The web
          // shell's re-auth surface no longer trips on a bare 403 (a forbidden
          // resource is not a dead session), so without this code the only
          // recovery affordance would disappear for the one 403 that genuinely
          // needs it. Additive and optional on the wire: a client that does not
          // know the code still sees a plain 403.
          response = forbiddenResponse({ code: AuthErrorCode.OrgForbidden });
          return response;
        }
        if (orgResolution.kind === "unverifiable") {
          // ISS-5118: the org lookup FAILED rather than answering "no". That is an
          // availability problem, not an authorization decision, so it must not
          // wear a 403 — telemetry could not tell an outage from a denial, and the
          // client's 403 copy told the user to re-authenticate, which cannot fix a
          // provider outage. A retryable 503 with its own code says what happened.
          response = serviceUnavailableResponse(ORG_UNVERIFIABLE_MESSAGE, {
            code: AuthErrorCode.OrgUnverifiable,
          });
          return response;
        }
        const effectiveClerkOrgId = orgResolution.clerkOrgId;
        const effectiveOrgRole = orgResolution.orgRole;

        const user = await findOrCreateUser(clerkUserId, effectiveClerkOrgId);

        if (!user?.active) {
          response = unauthorizedResponse();
          return response;
        }

        // Recorded only once a live user has resolved against the effective
        // org. A 401, a session-level 403, and the 503 above all leave the org
        // and user absent — there is no tenant or actor to attribute them to.
        recordRequestAuthenticatedIdentity({
          organizationId: user.organizationId,
          userId: user.id,
        });

        const authContext: AuthContext = {
          user,
          clerkUserId,
          clerkOrgId: effectiveClerkOrgId,
          orgRole: effectiveOrgRole,
          authMethod: "session",
          apiKeyScopes: undefined,
          clerkSessionId,
        };

        // ISS-12048: the caller's Dev Tools overrides, applied only once the
        // API has verified Dev Mode for this user itself.
        response = await withPostHogRequestContext(request.headers, () =>
          runWithFeatureFlagOverrides(
            request,
            { clerkUserId, email: user.email },
            () => handler(authContext, request, routeContext.params)
          )
        );
        return response;
      } catch (error) {
        recordRequestErrorCause(error, SpanErrorSource.AuthWrapper);
        response = authErrorResponse("Authentication failed", error);
        return response;
      } finally {
        // #5508 review: the admin-denial throttle only materialises a
        // suppressed count on an event, so without a terminal drain a burst
        // followed by quiet at that gate sat in memory until the same key was
        // hit again. BEFORE `logRequestCompleted`, because that call starts the
        // log flush synchronously — a rollup emitted after it would miss this
        // request's flush and wait for the next one. O(1) when nothing has
        // expired.
        drainOrgAdminDenials();
        logRequestCompleted(
          request,
          startMs,
          response?.status ?? 500,
          await readResponseErrorCode(response),
          await readRouteParams(routeContext)
        );
      }
    });
}

function authErrorResponse(
  message: string,
  error: unknown,
  status = 500
): NextResponse<ApiResult<never>> {
  log.error(message, { error });
  return NextResponse.json(failure(message), { status });
}
