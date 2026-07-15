import "server-only";

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/user";
import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import {
  forbiddenResponse,
  logRequestCompleted,
  unauthorizedResponse,
} from "../route-utils";
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
  authMethod: "session" | "api_key" | "desktop_session";
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
  return async (
    request: NextRequest,
    routeContext: RouteContext<TRoute>
  ): Promise<AuthenticatedJsonResponse<TResponse>> => {
    const startMs = globalThis.performance.now();
    let response: AuthenticatedJsonResponse<TResponse> | undefined;
    try {
      const { userId: clerkUserId, orgId: clerkOrgId, orgRole } = await auth();

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
        response = forbiddenResponse();
        return response;
      }
      const effectiveClerkOrgId = orgResolution.clerkOrgId;
      const effectiveOrgRole = orgResolution.orgRole;

      const user = await findOrCreateUser(clerkUserId, effectiveClerkOrgId);

      if (!user?.active) {
        response = unauthorizedResponse();
        return response;
      }

      const authContext: AuthContext = {
        user,
        clerkUserId,
        clerkOrgId: effectiveClerkOrgId,
        orgRole: effectiveOrgRole,
        authMethod: "session",
        apiKeyScopes: undefined,
      };

      response = await handler(authContext, request, routeContext.params);
      return response;
    } catch (error) {
      response = authErrorResponse("Authentication failed", error);
      return response;
    } finally {
      logRequestCompleted(request, startMs, response?.status ?? 500);
    }
  };
}

function authErrorResponse(
  message: string,
  error: unknown,
  status = 500
): NextResponse<ApiResult<never>> {
  const errorMessage = parseError(error);
  log.error(message, { error: errorMessage });
  return NextResponse.json(failure(message), { status });
}
