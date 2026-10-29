import "server-only";

import { SpanErrorSource } from "@closedloop-ai/telemetry-contract/span";
import { failure } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { runWithFeatureFlagOverrides } from "../feature-flags/feature-flag-request-scope-auth";
import { readResponseErrorCode } from "../observability/request-error-code";
import { readRouteParams } from "../observability/request-route-path";
import {
  recordRequestAuthenticatedIdentity,
  recordRequestClientAttribution,
  recordRequestErrorCause,
  runWithRequestSpanAttribution,
} from "../observability/request-span-attribution";
import {
  getBearerToken,
  logRequestCompleted,
  unauthorizedResponse,
} from "../route-utils";
import { resolveDesktopSessionContext } from "./desktop-session-auth";
import type {
  AuthContext,
  AuthenticatedHandler,
  AuthenticatedJsonResponse,
  RouteContext,
} from "./with-auth";

/**
 * Higher-order function that wraps route handlers with desktop-session auth.
 *
 * Only reached after `withAnyAuth` preclassifies the bearer token as a desktop
 * access token by its non-secret `typ` header. Mirrors `withApiKeyAuth`: it
 * resolves the same internal `userId`/`organizationId` shape, but with
 * `authMethod: "desktop_session"` and no scopes.
 *
 * On ANY verification or identity failure this returns 401 and NEVER falls
 * through to Clerk session auth — that no-fall-through guarantee is the core of
 * the FEA-2217 routing contract.
 */
export function withDesktopSessionAuth<
  TResponse,
  TRoute extends string = string,
>(
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
    // that emits the span. See `with-api-key-auth.ts` for the full note. This
    // is the lane the desktop sync client rides, so it is the one whose spans
    // the 4,453-500s investigation actually reads.
    runWithRequestSpanAttribution(async () => {
      const startMs = globalThis.performance.now();
      let response: AuthenticatedJsonResponse<TResponse> | undefined;
      try {
        // ISS-8749 / ISS-11431: the caller's own account of which Desktop
        // install and build this is, recorded before any auth decision so a
        // 401 burst names the installs it rejected. Attested, never trusted: it
        // reaches the span and nothing else.
        recordRequestClientAttribution(request.headers);
        const token = getBearerToken(request);
        if (!token) {
          response = unauthorizedResponse();
          return response;
        }

        const resolved = await resolveDesktopSessionContext(token);
        if (!resolved) {
          response = unauthorizedResponse();
          return response;
        }

        // Recorded only after the token verified and the user/org resolved.
        // Every 401 above leaves the org and user absent.
        recordRequestAuthenticatedIdentity({
          organizationId: resolved.organizationId,
          userId: resolved.user.id,
        });

        const authContext: AuthContext = {
          user: resolved.user,
          clerkUserId: resolved.user.clerkId,
          clerkOrgId: resolved.clerkOrgId,
          orgRole: undefined,
          authMethod: "desktop_session",
          desktopSessionId: resolved.desktopSessionId,
          apiKeyScopes: undefined,
        };

        // ISS-12048: same Dev Mode overrides scope as the browser session.
        response = await runWithFeatureFlagOverrides(
          request,
          { clerkUserId: resolved.user.clerkId, email: resolved.user.email },
          () => handler(authContext, request, routeContext.params)
        );
        return response;
      } catch (error) {
        log.error("Desktop session authentication failed", {
          error: parseError(error),
        });
        recordRequestErrorCause(error, SpanErrorSource.AuthWrapper);
        response = NextResponse.json(failure("Authentication failed"), {
          status: 500,
        });
        return response;
      } finally {
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
