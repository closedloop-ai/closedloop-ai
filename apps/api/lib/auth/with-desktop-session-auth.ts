import "server-only";

import { failure } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
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
  return async (
    request: NextRequest,
    routeContext: RouteContext<TRoute>
  ): Promise<AuthenticatedJsonResponse<TResponse>> => {
    const startMs = globalThis.performance.now();
    let response: AuthenticatedJsonResponse<TResponse> | undefined;
    try {
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

      const authContext: AuthContext = {
        user: resolved.user,
        clerkUserId: resolved.user.clerkId,
        clerkOrgId: resolved.clerkOrgId,
        orgRole: undefined,
        authMethod: "desktop_session",
        apiKeyScopes: undefined,
      };

      response = await handler(authContext, request, routeContext.params);
      return response;
    } catch (error) {
      log.error("Desktop session authentication failed", {
        error: parseError(error),
      });
      response = NextResponse.json(failure("Authentication failed"), {
        status: 500,
      });
      return response;
    } finally {
      logRequestCompleted(request, startMs, response?.status ?? 500);
    }
  };
}
