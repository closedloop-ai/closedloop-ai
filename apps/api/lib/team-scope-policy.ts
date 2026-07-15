import { teamsService } from "@/app/teams/service";
import { isAgentMonitoringEnabledForUser } from "@/lib/agent-session-sync-feature";
import { isOrgAdmin } from "@/lib/auth/org-admin";

/**
 * Authorizes a team-scoped read before any resource-specific data access.
 * Missing team ids fail closed when the caller requested team scope; callers
 * with no team-shaped request are allowed to continue through their own scope.
 */
export async function authorizeTeamScopeRead(input: {
  organizationId: string;
  userId: string;
  clerkOrgId: string;
  clerkUserId: string;
  teamId?: string;
  requiresTeamScope: boolean;
}): Promise<boolean> {
  if (!input.teamId) {
    return !input.requiresTeamScope;
  }

  const monitoringEnabled = await isAgentMonitoringEnabledForUser({
    userId: input.userId,
    clerkUserId: input.clerkUserId,
  });
  if (!monitoringEnabled) {
    return false;
  }

  const team = await teamsService.findById(input.teamId, input.organizationId);
  if (!team) {
    return false;
  }

  if (await teamsService.isMember(input.teamId, input.userId)) {
    return true;
  }

  return isOrgAdmin(input.clerkOrgId, input.clerkUserId);
}
