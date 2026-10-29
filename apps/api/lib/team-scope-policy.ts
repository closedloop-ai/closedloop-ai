import type { ApiResult } from "@repo/api/src/types/common";
import type { NextResponse } from "next/server";
import { teamsService } from "@/app/teams/service";
import { getOrgAdminStatus } from "@/lib/auth/org-admin";
import {
  OrgAdminDenialReason,
  roleUnresolvedResponse,
} from "@/lib/auth/org-admin-denial";
import { forbiddenResponse } from "@/lib/route-utils";

/**
 * The verdict on a team-scoped read.
 *
 * `Unresolved` exists because the org-admin fallback below can fail to answer:
 * folding that into `Denied` told the caller they lack access when the truth
 * was that nobody could check (ISS-8661).
 */
export const TeamScopeAuthorization = {
  Allowed: "allowed",
  Denied: "denied",
  Unresolved: "unresolved",
} as const;
export type TeamScopeAuthorization =
  (typeof TeamScopeAuthorization)[keyof typeof TeamScopeAuthorization];

/**
 * Authorizes a team-scoped read before any resource-specific data access.
 * Missing team ids fail closed when the caller requested team scope; callers
 * with no team-shaped request are allowed to continue through their own scope.
 *
 * FEA-4155 (whitlockk review #3789): the winding-down `DESKTOP_AGENT_SESSION_SYNC`
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
}): Promise<TeamScopeAuthorization> {
  if (!input.teamId) {
    return input.requiresTeamScope
      ? TeamScopeAuthorization.Denied
      : TeamScopeAuthorization.Allowed;
  }

  const teamExists = await teamsService.existsInOrganization(
    input.teamId,
    input.organizationId
  );
  if (!teamExists) {
    return TeamScopeAuthorization.Denied;
  }

  if (await teamsService.isMember(input.teamId, input.userId)) {
    return TeamScopeAuthorization.Allowed;
  }

  const adminStatus = await getOrgAdminStatus(
    input.clerkOrgId,
    input.clerkUserId
  );
  if (adminStatus.isAdmin) {
    return TeamScopeAuthorization.Allowed;
  }
  return adminStatus.reason === OrgAdminDenialReason.ProviderError
    ? TeamScopeAuthorization.Unresolved
    : TeamScopeAuthorization.Denied;
}

/**
 * The response a team-scoped read owes its caller, or `null` when the read may
 * proceed. Exhaustive by construction so a new {@link TeamScopeAuthorization}
 * fails typecheck until it is deliberately answered.
 */
export function teamScopeRefusalResponse(
  authorization: TeamScopeAuthorization
): NextResponse<ApiResult<never>> | null {
  return TEAM_SCOPE_REFUSALS[authorization]();
}

const TEAM_SCOPE_REFUSALS: Record<
  TeamScopeAuthorization,
  () => NextResponse<ApiResult<never>> | null
> = {
  [TeamScopeAuthorization.Allowed]: () => null,
  [TeamScopeAuthorization.Denied]: () => forbiddenResponse(),
  [TeamScopeAuthorization.Unresolved]: () => roleUnresolvedResponse(),
};
