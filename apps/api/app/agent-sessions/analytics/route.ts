import type { AgentSessionAnalytics } from "@repo/api/src/types/agent-session";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseQueryParams, successResponse } from "@/lib/route-utils";
import { teamScopeRefusalResponse } from "@/lib/team-scope-policy";
import { listQueryRefusalMetadata } from "../list-query-param";
import { authorizeAgentSessionTeamScope } from "../route-helpers";
import { agentSessionsService } from "../service";
import { baseAgentSessionQuerySchema } from "../validators";

// FEA-4155: no `monitoringEnabled` flag gate (see the sibling list route). The
// Sessions surface is always-on now, so this analytics read must not 403 as the
// winding-down `DESKTOP_AGENT_SESSION_SYNC` flag resolves false. Org/team RBAC
// stays via `authorizeAgentSessionTeamScope`.
export const GET = withAnyAuth<
  AgentSessionAnalytics,
  "/agent-sessions/analytics"
>(async ({ user, clerkOrgId, clerkUserId }, request) => {
  const { params, errorResponse } = parseQueryParams(
    request,
    baseAgentSessionQuerySchema,
    {
      errorMetadata: listQueryRefusalMetadata,
    }
  );
  if (errorResponse) {
    return errorResponse;
  }

  const teamScopeAllowed = await authorizeAgentSessionTeamScope({
    organizationId: user.organizationId,
    userId: user.id,
    clerkOrgId,
    clerkUserId,
    filters: params,
  });
  const teamScopeRefusal = teamScopeRefusalResponse(teamScopeAllowed);
  if (teamScopeRefusal) {
    return teamScopeRefusal;
  }

  const analytics = await agentSessionsService.getAnalytics({
    organizationId: user.organizationId,
    // FEA-3534: enforce `viewerScope=self` for Me-scoped analytics reads.
    viewerId: user.id,
    filters: params,
  });

  return successResponse(analytics);
});
