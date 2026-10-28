import "server-only";

import { OrganizationRole } from "@repo/api/src/types/organization-role";
import { TeamRole } from "@repo/api/src/types/teams";
import { withDb } from "@repo/database";
import type { ClerkOrganizationMembership } from "./clerk-service";

/**
 * ISS-12135: the organization roster of a seeded vibe stack, read from its
 * rows. A `pnpm vibe up` stack has no Clerk, and a seeded Vercel vibe preview
 * binds a real Clerk organization whose members are not the seeded people, so
 * on both the people exist only as rows.
 *
 * Organization roles are not team roles, so a team someone creates later never
 * changes them. Each person takes the role the seed gave them on the
 * organization's FIRST team, the home team the seed sets up
 * (`apps/api/scripts/vibe-seed/core/org-people.ts`): its owner is the
 * organization's owner. `signedIn`, when given, holds the role their session
 * reports instead. Every active user is a member; the list is ordered oldest
 * first with the id breaking ties.
 */
export async function listSeededRoster(params: {
  clerkOrgId: string;
  signedIn?: { clerkUserId: string; role: string };
}): Promise<ClerkOrganizationMembership[]> {
  const { homeTeam, users } = await withDb(async (db) => {
    const team = await db.team.findFirst({
      where: { organization: { clerkId: params.clerkOrgId } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const rows = await db.user.findMany({
      where: { active: true, organization: { clerkId: params.clerkOrgId } },
      select: {
        id: true,
        clerkId: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        createdAt: true,
        updatedAt: true,
        teamMemberships: {
          // No team means no home-team role: match nothing.
          where: team ? { teamId: team.id } : { id: { in: [] } },
          select: { role: true },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return { homeTeam: team, users: rows };
  });
  return users.map((user) => ({
    id: `orgmem_${user.id}`,
    userId: user.clerkId,
    role:
      params.signedIn && user.clerkId === params.signedIn.clerkUserId
        ? params.signedIn.role
        : organizationRoleFor(
            homeTeam ? user.teamMemberships.at(0)?.role : undefined
          ),
    identifier: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    imageUrl: user.avatarUrl,
    createdAt: user.createdAt.getTime(),
    updatedAt: user.updatedAt.getTime(),
  }));
}

function organizationRoleFor(homeTeamRole: string | undefined): string {
  if (homeTeamRole === TeamRole.Owner) {
    return OrganizationRole.Owner;
  }
  if (homeTeamRole === TeamRole.Admin) {
    return OrganizationRole.Admin;
  }
  return OrganizationRole.Member;
}
