import "server-only";

import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { isDesktopSessionToken } from "@repo/auth/desktop-session-jwt";
import type { NextRequest } from "next/server";
import {
  assertRequiredApiKeyScopes,
  type RequiredApiKeyScopes,
} from "./api-key-scopes";
import { withApiKeyAuth } from "./with-api-key-auth";
import type {
  AuthenticatedHandler,
  AuthenticatedJsonResponse,
} from "./with-auth";
import { withAuth } from "./with-auth";
import { withDesktopSessionAuth } from "./with-desktop-session-auth";

/**
 * Higher-order function that wraps route handlers with flexible authentication.
 *
 * Routes by the `Authorization: Bearer <token>` header (FEA-2217 contract):
 * - `Bearer sk_live_*` → withApiKeyAuth (API-key auth).
 * - Token preclassified as a desktop access token by its non-secret `typ`
 *   header → withDesktopSessionAuth, which short-circuits: a desktop-typed token
 *   that fails verification returns 401 and never falls through to Clerk.
 * - Otherwise → withAuth (Clerk session auth).
 *
 * This allows routes to accept programmatic (API key), desktop-session, and
 * browser (Clerk session) clients through one central path.
 *
 * API-key scopes: `options.requiredScopes` when given, otherwise the method
 * default (read for GET and HEAD, delete for DELETE, write otherwise). The
 * fallback is per field (ISS-11792), so an options object without scopes still
 * gets the default. An empty list is refused: it does not compile, and an
 * untyped one throws when the wrapper is built.
 *
 * @example
 * export const POST = withAnyAuth<ResponseType, '/path'>(async ({ user }, request) => {
 *   return NextResponse.json(success(data));
 * });
 */
export function withAnyAuth<TResponse, TRoute extends string = string>(
  handler: AuthenticatedHandler<TResponse, TRoute>,
  options?: { requiredScopes?: RequiredApiKeyScopes }
): (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> }
) => Promise<AuthenticatedJsonResponse<TResponse>> {
  const routeScopes = options?.requiredScopes
    ? assertRequiredApiKeyScopes(options.requiredScopes, "withAnyAuth")
    : undefined;

  return (
    request: NextRequest,
    context: { params: Promise<Record<string, string>> }
  ): Promise<AuthenticatedJsonResponse<TResponse>> => {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (token?.startsWith("sk_live_")) {
      return withApiKeyAuth<TResponse, TRoute>(handler, {
        requiredScopes:
          routeScopes ?? defaultApiKeyScopesForMethod(request.method),
      })(request, context);
    }

    if (token && isDesktopSessionToken(token)) {
      return withDesktopSessionAuth<TResponse, TRoute>(handler)(
        request,
        context
      );
    }

    return withAuth<TResponse, TRoute>(handler)(request, context);
  };
}

/** The scope an API key needs on a route that declares none. */
function defaultApiKeyScopesForMethod(method: string): RequiredApiKeyScopes {
  if (method === "GET" || method === "HEAD") {
    return [ApiKeyScope.Read];
  }
  if (method === "DELETE") {
    return [ApiKeyScope.Delete];
  }
  return [ApiKeyScope.Write];
}
