import type { InsightsPeriod } from "@repo/api/src/types/insights";
import { InsightsScope } from "@repo/api/src/types/insights";
import type { User } from "@repo/api/src/types/user";
import type { NextRequest } from "next/server";
import { isInsightsEnabledForUser } from "@/lib/insights-feature";
import {
  errorResponse,
  forbiddenResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { authorizeTeamScopeRead } from "@/lib/team-scope-policy";
import type { InsightsScopeContext } from "../service";
import { insightsQueryValidator } from "../validators";

/**
 * Shared handler for the Insights section routes. Fails closed on the `insights`
 * feature flag (the whole surface is dark-launched behind it), parses the
 * `period` and `scope` query params, resolves the scope context from the
 * authenticated user, delegates to the section service, and maps the result to a
 * response.
 */
export function createInsightsHandler<TResponse>(config: {
  fetch: (
    ctx: InsightsScopeContext,
    period: InsightsPeriod
  ) => Promise<TResponse>;
  errorMessage: string;
}) {
  return async (
    {
      user,
      clerkOrgId,
      clerkUserId,
    }: { user: User; clerkOrgId: string; clerkUserId: string },
    request: NextRequest
  ) => {
    if (!(await isInsightsEnabledForUser({ userId: user.id, clerkUserId }))) {
      return forbiddenResponse();
    }

    const { params, errorResponse: paramsError } = parseQueryParams(
      request,
      insightsQueryValidator
    );
    if (paramsError) {
      return paramsError;
    }

    try {
      if (params.scope === InsightsScope.Team) {
        const teamScopeAllowed = await authorizeTeamScopeRead({
          organizationId: user.organizationId,
          userId: user.id,
          clerkOrgId,
          clerkUserId,
          teamId: params.teamId,
          requiresTeamScope: true,
        });
        if (!teamScopeAllowed) {
          return forbiddenResponse();
        }
      }
      const ctx: InsightsScopeContext = {
        organizationId: user.organizationId,
        userId: user.id,
        scope: params.scope,
        teamId: params.scope === InsightsScope.Team ? params.teamId : undefined,
        timeZone: params.timeZone,
      };
      const result = await config.fetch(ctx, params.period);
      return successResponse(result);
    } catch (error) {
      return errorResponse(config.errorMessage, error);
    }
  };
}
