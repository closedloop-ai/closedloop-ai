import type {
  InsightsPeriod,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { InsightsScope } from "@repo/api/src/types/insights";
import type { SessionAnalyticsSection } from "@repo/api/src/types/session-analytics";
import type { User } from "@repo/api/src/types/user";
import { log } from "@repo/observability/log";
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
 *
 * A section failure is logged under `insights.<section>_failed` with the
 * org/user/scope correlation the handler holds (FEA-3031) — `errorResponse`
 * logs only the prose message and the raw error, which leaves a Datadog
 * operator with no way to pivot to the org, user, or team that hit it.
 */
export function createInsightsHandler<TResponse>(config: {
  fetch: (
    ctx: InsightsScopeContext,
    period: InsightsPeriod
  ) => Promise<TResponse>;
  // Also accepts the standalone session-analytics routes, which are not
  // dashboard sections. Used only to
  // name the failure log event.
  section: InsightsSection | SessionAnalyticsSection;
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

    // Hoisted out of the `try` so the catch can correlate a failure raised by
    // the team-scope authorization as well as one raised by the service.
    const correlation = {
      organizationId: user.organizationId,
      userId: user.id,
      scope: params.scope,
      teamId: params.scope === InsightsScope.Team ? params.teamId : undefined,
    };

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
        ...correlation,
        timeZone: params.timeZone,
      };
      const result = await config.fetch(ctx, params.period);
      return successResponse(result);
    } catch (error) {
      log.error(`insights.${config.section}_failed`, { error, ...correlation });
      return errorResponse(config.errorMessage, error);
    }
  };
}
