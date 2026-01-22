import "server-only";

import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { auth, verifyToken } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import type { AppRouteHandlerRoutes } from "@/.next/types/routes";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { clerkService } from "@/lib/auth/clerk-service";
import { unauthorizedResponse } from "../route-utils";

/**
 * Context passed to authenticated route handlers.
 */
export type AuthContext = {
  user: User;
  clerkUserId: string;
  clerkOrgId: string;
};

/**
 * Route handler function type using Next.js RouteContext.
 *
 * @template TResponse - The response data type
 * @template TRoute - The route literal (e.g., '/projects/[id]') for type-safe params
 */
export type AuthenticatedHandler<
  TResponse,
  TRoute extends AppRouteHandlerRoutes = AppRouteHandlerRoutes,
> = (
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
export function withAuth<
  TResponse,
  TRoute extends AppRouteHandlerRoutes = AppRouteHandlerRoutes,
>(
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
      const { clerkUserId, clerkOrgId } = await getAuthCredentials(request);

      if (!(clerkUserId && clerkOrgId)) {
        return unauthorizedResponse();
      }

      const user = await findOrCreateUser(clerkUserId, clerkOrgId);
      const authContext: AuthContext = { user, clerkUserId, clerkOrgId };

      return handler(authContext, request, routeContext.params);
    } catch (error) {
      return authErrorResponse("Authentication failed", error);
    }
  };
}

/**
 * Gets auth credentials from Clerk session or Bearer token.
 */
async function getAuthCredentials(
  request: NextRequest
): Promise<{ clerkUserId?: string; clerkOrgId?: string }> {
  // Try standard Clerk auth first (works with cookies/session)
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();

  if (clerkUserId) {
    return { clerkUserId, clerkOrgId };
  }

  // Fallback: try Bearer token from Authorization header
  return verifyBearerToken(request);
}

/**
 * Verifies a Bearer token from the Authorization header.
 */
async function verifyBearerToken(
  request: NextRequest
): Promise<{ clerkUserId?: string; clerkOrgId?: string }> {
  const authHeader = request.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return {};
  }

  const token = authHeader.slice(7);
  const secretKey = process.env.CLERK_SECRET_KEY;

  if (!secretKey) {
    return {};
  }

  try {
    const verifiedToken = await verifyToken(token, { secretKey });
    return {
      clerkUserId: verifiedToken.sub,
      clerkOrgId: verifiedToken.org_id,
    };
  } catch {
    return {};
  }
}

async function findOrCreateUser(
  clerkUserId: string,
  clerkOrgId: string
): Promise<User> {
  // Try to find existing user
  const existingUser = await usersService.findByClerkId(clerkUserId);

  if (existingUser) {
    return existingUser;
  }

  // Ensure organization exists first
  const organization = await findOrCreateOrganization(clerkOrgId);

  // Fetch user details from Clerk
  log.info("User not found, fetching from Clerk", { clerkUserId });

  const clerkUser = await clerkService.getUser(clerkUserId);

  // Create the user
  const user = await usersService.create({
    clerkId: clerkUserId,
    organizationId: organization.id,
    email: clerkUser.email,
    firstName: clerkUser.firstName,
    lastName: clerkUser.lastName,
    avatarUrl: clerkUser.imageUrl,
    phoneNumber: clerkUser.phoneNumber,
  });

  log.info("Created user from Clerk", {
    userId: user.id,
    clerkUserId,
    organizationId: organization.id,
  });

  return user;
}

async function findOrCreateOrganization(clerkOrgId: string) {
  const existingOrg = await organizationsService.findByClerkId(clerkOrgId);

  if (existingOrg) {
    return existingOrg;
  }

  // Fetch organization details from Clerk
  log.info("Organization not found, fetching from Clerk", { clerkOrgId });

  const clerkOrg = await clerkService.getOrganization(clerkOrgId);

  const organization = await organizationsService.create({
    clerkId: clerkOrgId,
    name: clerkOrg.name,
    slug: clerkOrg.slug ?? clerkOrgId,
  });

  log.info("Created organization from Clerk", {
    organizationId: organization.id,
    clerkOrgId,
  });

  return organization;
}

function authErrorResponse(
  message: string,
  error: unknown,
  status = 500
): NextResponse<ApiResult<never>> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  log.error(message, { error: errorMessage });
  return NextResponse.json(failure(message), { status });
}
