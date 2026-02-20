import "server-only";

import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import type { ApiResult } from "@repo/api/src/types/common";
import type { NextRequest, NextResponse } from "next/server";
import { withApiKeyAuth } from "./with-api-key-auth";
import type { AuthenticatedHandler } from "./with-auth";
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
) => Promise<NextResponse<ApiResult<TResponse>>> {
  return (
    request: NextRequest,
    context: { params: Promise<Record<string, string>> }
  ): Promise<NextResponse<ApiResult<TResponse>>> => {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (token?.startsWith("sk_live_")) {
      const effectiveOptions =
        options ??
        (request.method === "GET" || request.method === "HEAD"
          ? { requiredScopes: ["read"] as ApiKeyScope[] }
          : undefined);
      return withApiKeyAuth<TResponse, TRoute>(handler, effectiveOptions)(
        request,
        context as { params: Promise<Record<string, string>> }
      );
    }

    return withAuth<TResponse, TRoute>(handler)(
      request,
      context as { params: Promise<Record<string, string>> }
    );
  };
}
