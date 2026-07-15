import "server-only";

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { isDesktopSessionToken } from "@repo/auth/desktop-session-jwt";
import type { NextRequest } from "next/server";
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
 * @example
 * export const POST = withAnyAuth<ResponseType, '/path'>(async ({ user }, request) => {
 *   return NextResponse.json(success(data));
 * });
 */
export function withAnyAuth<TResponse, TRoute extends string = string>(
  handler: AuthenticatedHandler<TResponse, TRoute>,
  options?: { requiredScopes?: ApiKeyScope[] }
): (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> }
) => Promise<AuthenticatedJsonResponse<TResponse>> {
  return (
    request: NextRequest,
    context: { params: Promise<Record<string, string>> }
  ): Promise<AuthenticatedJsonResponse<TResponse>> => {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (token?.startsWith("sk_live_")) {
      let fallbackOptions: { requiredScopes: ApiKeyScope[] };

      if (request.method === "GET" || request.method === "HEAD") {
        fallbackOptions = { requiredScopes: ["read"] };
      } else if (request.method === "DELETE") {
        fallbackOptions = { requiredScopes: ["delete"] };
      } else {
        fallbackOptions = { requiredScopes: ["write"] };
      }
      const effectiveOptions = options ?? fallbackOptions;
      return withApiKeyAuth<TResponse, TRoute>(handler, effectiveOptions)(
        request,
        context
      );
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
