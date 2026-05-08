import "server-only";

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { failure } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { type NextRequest, NextResponse } from "next/server";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import {
  forbiddenResponse,
  logRequestCompleted,
  unauthorizedResponse,
} from "../route-utils";
import type { VerifiedApiKeyContextWithMetadata } from "./api-key-context";
import { hasApiKeyScopes } from "./api-key-scopes";
import { getDesktopManagedPopRequestFailure } from "./desktop-managed-pop";
import type {
  AuthContext,
  AuthenticatedHandler,
  AuthenticatedJsonResponse,
  RouteContext,
} from "./with-auth";

type ApiKeyAuthOptions = {
  requiredScopes?: ApiKeyScope[];
};

type ResolveApiKeyResult =
  | {
      context: VerifiedApiKeyContextWithMetadata & {
        clerkUserId?: string | null;
      };
      response: null;
    }
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
    const startMs = globalThis.performance.now();
    let response: AuthenticatedJsonResponse<TResponse> | undefined;
    try {
      const token = getBearerToken(request);

      if (!token?.startsWith("sk_live_")) {
        response = unauthorizedResponse();
        return response;
      }

      const apiKeyResult = await resolveApiKeyContext(token, options);
      if (apiKeyResult.response) {
        response =
          apiKeyResult.response as AuthenticatedJsonResponse<TResponse>;
        return response;
      }
      const keyContext = apiKeyResult.context;

      const user = await usersService.findById(
        keyContext.userId,
        keyContext.organizationId
      );

      if (!user?.active) {
        response = unauthorizedResponse();
        return response;
      }

      const popFailure = await getDesktopManagedPopRequestFailure({
        keyContext: { ...keyContext, clerkUserId: user.clerkId },
        request,
      });
      if (popFailure) {
        response = NextResponse.json(failure(popFailure.message), {
          status: popFailure.status,
        });
        return response;
      }
      waitUntil(apiKeysService.touchLastUsedAt(keyContext.apiKeyId));

      const organization = await organizationsService.findById(
        keyContext.organizationId
      );

      if (!organization) {
        response = unauthorizedResponse();
        return response;
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
        response = forbiddenResponse();
        return response;
      }

      response = await handler(authContext, request, routeContext.params);
      return response;
    } catch (error) {
      const errorMessage = parseError(error);
      log.error("API key authentication failed", { error: errorMessage });
      response = NextResponse.json(failure("Authentication failed"), {
        status: 500,
      });
      return response;
    } finally {
      logRequestCompleted(request, startMs, response?.status ?? 500);
    }
  };
}

function getBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

async function resolveApiKeyContext(
  token: string,
  _options: ApiKeyAuthOptions | undefined
): Promise<ResolveApiKeyResult> {
  const context = await apiKeysService.verifyKeyWithMetadata(token, {
    updateLastUsedAt: false,
  });
  if (!context) {
    return unauthorizedResult();
  }
  return { context, response: null };
}

function unauthorizedResult(): ResolveApiKeyResult {
  return { context: null, response: unauthorizedResponse() };
}
