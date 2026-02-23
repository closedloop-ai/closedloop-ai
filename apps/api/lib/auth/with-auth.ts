import "server-only";

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { clerkService } from "@/lib/auth/clerk-service";
import { unauthorizedResponse } from "../route-utils";

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
  authMethod: "session" | "api_key";
  apiKeyScopes?: ApiKeyScope[];
};

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
) => Promise<NextResponse<ApiResult<TResponse>>>;

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
) => Promise<NextResponse<ApiResult<TResponse>>> {
  return async (
    request: NextRequest,
    routeContext: RouteContext<TRoute>
  ): Promise<NextResponse<ApiResult<TResponse>>> => {
    try {
      const { userId: clerkUserId, orgId: clerkOrgId, orgRole } = await auth();

      if (!(clerkUserId && clerkOrgId)) {
        return unauthorizedResponse();
      }

      const user = await findOrCreateUser(clerkUserId, clerkOrgId);

      if (!user?.active) {
        return unauthorizedResponse();
      }

      const authContext: AuthContext = {
        user,
        clerkUserId,
        clerkOrgId,
        orgRole: orgRole ?? undefined,
        authMethod: "session",
        apiKeyScopes: undefined,
      };

      return handler(authContext, request, routeContext.params);
    } catch (error) {
      return authErrorResponse("Authentication failed", error);
    }
  };
}

async function findOrCreateUser(
  clerkUserId: string,
  clerkOrgId: string
): Promise<User | null> {
  const organization =
    await organizationsService.findOrCreateByClerkId(clerkOrgId);

  const existingUser = await usersService.findByClerkIdAndOrg(
    clerkUserId,
    organization.id
  );

  if (existingUser) {
    return existingUser;
  }

  log.info("User not found, fetching from Clerk", { clerkUserId });

  const clerkUser = await clerkService.getUser(clerkUserId);

  const user = await usersService.upsertByClerkIdAndOrg({
    clerkId: clerkUserId,
    organizationId: organization.id,
    email: clerkUser.email,
    firstName: clerkUser.firstName,
    lastName: clerkUser.lastName,
    avatarUrl: clerkUser.imageUrl,
    phoneNumber: clerkUser.phoneNumber,
  });

  log.info("Created/updated user from Clerk", {
    userId: user.id,
    clerkUserId,
    organizationId: organization.id,
  });

  return user;
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
