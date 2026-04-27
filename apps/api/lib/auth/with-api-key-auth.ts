import "server-only";

import type {
  ApiKeyScope,
  VerifiedApiKeyContext,
} from "@repo/api/src/types/api-key";
import { failure } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { forbiddenResponse, unauthorizedResponse } from "../route-utils";
import { hasApiKeyScopes } from "./api-key-scopes";
import {
  getDesktopManagedPopFailure,
  resolveDesktopManagedPopMode,
  verifyDesktopManagedPop,
} from "./desktop-managed-pop";
import type {
  AuthContext,
  AuthenticatedHandler,
  AuthenticatedJsonResponse,
  RouteContext,
} from "./with-auth";

type ApiKeyAuthOptions = {
  desktopManagedPop?: boolean;
  requiredScopes?: ApiKeyScope[];
};

type ResolveApiKeyResult =
  | { context: VerifiedApiKeyContext; response: null }
  | { context: null; response: NextResponse };

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
  options?: ApiKeyAuthOptions
): (
  request: NextRequest,
  context: RouteContext<TRoute>
) => Promise<AuthenticatedJsonResponse<TResponse>> {
  return async (
    request: NextRequest,
    routeContext: RouteContext<TRoute>
  ): Promise<AuthenticatedJsonResponse<TResponse>> => {
    try {
      const token = getBearerToken(request);

      if (!token?.startsWith("sk_live_")) {
        return unauthorizedResponse();
      }

      const apiKeyResult = await resolveApiKeyContext(token, request, options);
      if (apiKeyResult.response) {
        return apiKeyResult.response as AuthenticatedJsonResponse<TResponse>;
      }
      const keyContext = apiKeyResult.context;

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
      return NextResponse.json(
        failure(getAuthenticationFailureMessage(options)),
        { status: options?.desktopManagedPop ? 503 : 500 }
      );
    }
  };
}

function getBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

async function resolveApiKeyContext(
  token: string,
  request: NextRequest,
  options: ApiKeyAuthOptions | undefined
): Promise<ResolveApiKeyResult> {
  if (!options?.desktopManagedPop) {
    const context = await apiKeysService.verifyKey(token);
    return context ? { context, response: null } : unauthorizedResult();
  }

  const context = await apiKeysService.verifyKeyWithMetadata(token, {
    updateLastUsedAt: false,
  });
  if (!context) {
    return unauthorizedResult();
  }

  const popDecision = verifyDesktopManagedPop({
    keyContext: context,
    mode: await resolveDesktopManagedPopMode(context),
    request,
  });
  const popFailure = getDesktopManagedPopFailure(popDecision);
  if (popFailure) {
    return {
      context: null,
      response: NextResponse.json(failure(popFailure.message), {
        status: popFailure.status,
      }),
    };
  }

  apiKeysService.touchLastUsedAt(context.apiKeyId);
  return { context, response: null };
}

function unauthorizedResult(): ResolveApiKeyResult {
  return { context: null, response: unauthorizedResponse() };
}

function getAuthenticationFailureMessage(options?: ApiKeyAuthOptions): string {
  return options?.desktopManagedPop
    ? "Desktop managed PoP verifier unavailable"
    : "Authentication failed";
}
