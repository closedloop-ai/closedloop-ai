import "server-only";

import { SpanErrorSource } from "@closedloop-ai/telemetry-contract/span";
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { failure } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { type NextRequest, NextResponse } from "next/server";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
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
  getBearerToken,
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
  return (
    request: NextRequest,
    routeContext: RouteContext<TRoute>
  ): Promise<AuthenticatedJsonResponse<TResponse>> =>
    // ISS-7217/ISS-7221: the attribution scope wraps the WHOLE request — the
    // handler, this wrapper's own catch, and the `finally` that emits the span
    // — so a failure the wrapper itself produces is still inside the scope the
    // emitter reads.
    runWithRequestSpanAttribution(() =>
      handleApiKeyAuthenticatedRequest(handler, options, request, routeContext)
    );
}

async function resolveApiKeyContext(
  token: string
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

/**
 * The wrapper body, extracted so the attribution scope adds no nesting level
 * to it — inlined, the extra closure pushed this function past the cognitive
 * complexity ceiling.
 */
async function handleApiKeyAuthenticatedRequest<
  TResponse,
  TRoute extends string,
>(
  handler: AuthenticatedHandler<TResponse, TRoute>,
  options: ApiKeyAuthOptions | undefined,
  request: NextRequest,
  routeContext: RouteContext<TRoute>
): Promise<AuthenticatedJsonResponse<TResponse>> {
  const startMs = globalThis.performance.now();
  let response: AuthenticatedJsonResponse<TResponse> | undefined;
  try {
    // ISS-8749 / ISS-11431: the caller's own account of which Desktop install
    // and build this is, recorded before any auth decision so a 401 burst
    // names the installs it rejected. Attested, never trusted: it reaches the
    // span and nothing else.
    recordRequestClientAttribution(request.headers);
    const token = getBearerToken(request);

    if (!token?.startsWith("sk_live_")) {
      response = unauthorizedResponse();
      return response;
    }

    const apiKeyResult = await resolveApiKeyContext(token);
    if (apiKeyResult.response) {
      response = apiKeyResult.response as AuthenticatedJsonResponse<TResponse>;
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

    // Recorded only now, once the key verified AND the org still exists. Every
    // earlier exit — an absent or unrecognized key, an inactive user, a failed
    // proof-of-possession, a vanished org — is a request that never established
    // who was calling, so it has no tenant or actor to name.
    //
    // The scope check BELOW is deliberately on the other side of this line
    // (ISS-8748). Its 403 is an authorization verdict on a caller whose
    // identity is already established, not a failure to authenticate, so the
    // span names the org and user it denied. "Which key is hitting endpoints it
    // lacks scopes for" is only answerable if it does.
    recordRequestAuthenticatedIdentity({
      organizationId: user.organizationId,
      userId: user.id,
    });

    const authContext: AuthContext = {
      user,
      clerkUserId: user.clerkId,
      clerkOrgId: organization.clerkId,
      orgRole: undefined,
      authMethod: "api_key",
      apiKeyId: keyContext.apiKeyId,
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
    log.error("API key authentication failed", { error });
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
}
