import type { InsightsPeriod } from "@repo/api/src/types/insights";
import type { User } from "@repo/api/src/types/user";
import type { NextRequest } from "next/server";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import type { InsightsScopeContext } from "../service";
import { insightsQueryValidator } from "../validators";

/**
 * Shared handler for the Insights section routes. Parses the `period` and
 * `scope` query params, resolves the scope context from the authenticated user,
 * delegates to the section service, and maps the result to a response.
 */
export function createInsightsHandler<TResponse>(config: {
  fetch: (
    ctx: InsightsScopeContext,
    period: InsightsPeriod
  ) => Promise<TResponse>;
  errorMessage: string;
}) {
  return async ({ user }: { user: User }, request: NextRequest) => {
    const { params, errorResponse: paramsError } = parseQueryParams(
      request,
      insightsQueryValidator
    );
    if (paramsError) {
      return paramsError;
    }

    try {
      const ctx: InsightsScopeContext = {
        organizationId: user.organizationId,
        userId: user.id,
        scope: params.scope,
      };
      const result = await config.fetch(ctx, params.period);
      return successResponse(result);
    } catch (error) {
      return errorResponse(config.errorMessage, error);
    }
  };
}
