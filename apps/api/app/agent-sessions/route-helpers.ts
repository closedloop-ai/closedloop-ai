import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { isAgentMonitoringEnabledForUser } from "@/lib/agent-session-sync-feature";
import { authorizeTeamScopeRead } from "@/lib/team-scope-policy";
import type { AgentSessionUsageQuery } from "./validators";

export async function getAgentSessionViewerScope(input: {
  userId: string;
  clerkUserId: string;
}): Promise<{
  monitoringEnabled: boolean;
}> {
  const monitoringEnabled = await isAgentMonitoringEnabledForUser({
    userId: input.userId,
    clerkUserId: input.clerkUserId,
  });

  return {
    monitoringEnabled,
  };
}

/**
 * Authorizes team-scoped agent-session reads before any session data query or
 * CSV stream starts. Legacy clients that send a bare `teamId` get the same
 * policy as explicit `viewerScope=team`.
 */
export function authorizeAgentSessionTeamScope(input: {
  organizationId: string;
  userId: string;
  clerkOrgId: string;
  clerkUserId: string;
  filters: AgentSessionUsageQuery;
}): Promise<boolean> {
  return authorizeTeamScopeRead({
    organizationId: input.organizationId,
    userId: input.userId,
    clerkOrgId: input.clerkOrgId,
    clerkUserId: input.clerkUserId,
    teamId: input.filters.teamId ?? undefined,
    requiresTeamScope:
      input.filters.viewerScope === AgentSessionViewerScope.Team,
  });
}
