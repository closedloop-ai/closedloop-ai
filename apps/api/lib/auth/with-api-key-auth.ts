import "server-only";

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { failure } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { forbiddenResponse, unauthorizedResponse } from "../route-utils";
import { hasApiKeyScopes } from "./api-key-scopes";
import type {
  AuthContext,
  AuthenticatedHandler,
  AuthenticatedJsonResponse,
  RouteContext,
} from "./with-auth";

/**
 * Higher-order function that wraps route handlers with API key authentication.
 *
 * Mirrors withAuth() signature but authenticates via Bearer token instead of Clerk session.
 *
 * Ensures:
 * - Authorization header is present with a Bearer token starting with `sk_live_`
 * - The API key is valid (not revoked, not expired)
 * - The associated user exists in the database and is active
 *
 * API-key sessions do not have an orgRole, so orgRole is always undefined.
 *
 * @example
 * export const GET = withApiKeyAuth<ResponseType, '/path'>(async ({ user }, request) => {
 *   return NextResponse.json(success(data));
 * });
 */
export function withApiKeyAuth<TResponse, TRoute extends string = string>(
  handler: AuthenticatedHandler<TResponse, TRoute>,
  options?: { requiredScopes?: ApiKeyScope[] }
): (
  request: NextRequest,
  context: RouteContext<TRoute>
) => Promise<AuthenticatedJsonResponse<TResponse>> {
  return async (
    request: NextRequest,
    routeContext: RouteContext<TRoute>
  ): Promise<AuthenticatedJsonResponse<TResponse>> => {
    try {
      const authHeader = request.headers.get("authorization");
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token?.startsWith("sk_live_")) {
        return unauthorizedResponse();
      }

      const keyContext = await apiKeysService.verifyKey(token);

      if (!keyContext) {
        return unauthorizedResponse();
      }

      const user = await usersService.findById(
        keyContext.userId,
        keyContext.organizationId
      );

      if (!user?.active) {
        return unauthorizedResponse();
      }

      const organization = await organizationsService.findById(
        keyContext.organizationId
      );

      if (!organization) {
        return unauthorizedResponse();
      }

      const authContext: AuthContext = {
        user,
        clerkUserId: user.clerkId,
        clerkOrgId: organization.clerkId,
        orgRole: undefined,
        authMethod: "api_key",
        apiKeyScopes: keyContext.scopes,
      };

      if (
        options?.requiredScopes &&
        !hasApiKeyScopes(authContext, options.requiredScopes)
      ) {
        return forbiddenResponse();
      }

      return handler(authContext, request, routeContext.params);
    } catch (error) {
      const errorMessage = parseError(error);
      log.error("API key authentication failed", { error: errorMessage });
      return NextResponse.json(failure("Authentication failed"), {
        status: 500,
      });
    }
  };
}
