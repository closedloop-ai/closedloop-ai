import "server-only";

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import type { NextRequest } from "next/server";
import { withApiKeyAuth } from "./with-api-key-auth";
import type {
  AuthenticatedHandler,
  AuthenticatedJsonResponse,
} from "./with-auth";
import { withAuth } from "./with-auth";

/**
 * Higher-order function that wraps route handlers with flexible authentication.
 *
 * Checks the Authorization header:
 * - If it starts with `Bearer sk_live_`, delegates to withApiKeyAuth (API key auth)
 * - Otherwise, delegates to withAuth (Clerk session auth)
 *
 * This allows routes to accept both programmatic (API key) and browser (session) clients.
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

    return withAuth<TResponse, TRoute>(handler)(request, context);
  };
}
