import { teamsService } from "@/app/teams/service";
import { isOrgAdmin } from "@/lib/auth/org-admin";

/**
 * Authorizes a team-scoped read before any resource-specific data access.
 * Missing team ids fail closed when the caller requested team scope; callers
 * with no team-shaped request are allowed to continue through their own scope.
 *
 * FEA-4155 (wongk review #3789): the winding-down `DESKTOP_AGENT_SESSION_SYNC`
 * monitoring flag check that used to gate this team-scope read is gone — it was
 * the same flag the always-on Sessions surface no longer gates on, so a
 * team-scoped read would still 403 as the flag winds down. Team membership and
 * org-admin below are the real RBAC boundary and stay.
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

  const team = await teamsService.findById(input.teamId, input.organizationId);
  if (!team) {
    return false;
  }

  if (await teamsService.isMember(input.teamId, input.userId)) {
    return true;
  }

  return isOrgAdmin(input.clerkOrgId, input.clerkUserId);
}
