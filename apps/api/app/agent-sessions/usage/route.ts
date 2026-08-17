import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  forbiddenResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  authorizeAgentSessionTeamScope,
  resolveDisplayedStatusParity,
} from "../route-helpers";
import { agentSessionsService } from "../service";
import { agentSessionUsageQuerySchema } from "../validators";

// FEA-4155: no `monitoringEnabled` flag gate — see the sibling list route. The
// Sessions surface is always-on now, so this usage read must not 403 as the
// winding-down `DESKTOP_AGENT_SESSION_SYNC` flag resolves false. Org/team RBAC
// stays via `authorizeAgentSessionTeamScope`.
export const GET = withAnyAuth<
  AgentSessionUsageSummary,
  "/agent-sessions/usage"
>(async ({ user, clerkOrgId, clerkUserId }, request) => {
  const { params, errorResponse } = parseQueryParams(
    request,
    agentSessionUsageQuerySchema
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
  if (!teamScopeAllowed) {
    return forbiddenResponse();
  }

  const summary = await agentSessionsService.getUsageSummary({
    organizationId: user.organizationId,
    // FEA-3534: enforce `viewerScope=self` for Me-scoped usage reads.
    viewerId: user.id,
    // ISS-4556 / ISS-4559: the cards summarize exactly the population the table
    // lists, so the Status facet must resolve the same gate the list route does.
    displayedStatusParity: await resolveDisplayedStatusParity({
      userId: user.id,
      clerkUserId,
    }),
    filters: params,
  });

  return successResponse(summary);
});
