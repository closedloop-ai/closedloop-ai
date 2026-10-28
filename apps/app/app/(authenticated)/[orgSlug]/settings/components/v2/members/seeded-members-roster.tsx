"use client";

import {
  isOrganizationRole,
  type OrganizationMemberSummary,
} from "@repo/api/src/types/organization-members";
import { OrganizationRole } from "@repo/api/src/types/organization-role";
import { TeamRole } from "@repo/api/src/types/teams";
import type { BasicUser } from "@repo/api/src/types/user";
import {
  MemberAvatarInfo,
  RoleSelect,
} from "@/app/(authenticated)/[orgSlug]/teams/components/member-row";

/**
 * ISS-12135: the Members roster of a seeded vibe stack, either a `pnpm vibe up`
 * stack (no Clerk, so Clerk's `<OrganizationProfile>` renders nothing) or a
 * seeded Vercel vibe preview (whose Clerk organization is a real one, so the
 * embed would list its real members). The roster the API reports for the
 * seeded org (`GET /organizations/members`, read by the panel) is shown
 * read-only instead, in the team member rows the Teams screen ships.
 */
export function SeededMembersRoster({
  currentUserId,
  labelledBy,
  members,
}: Readonly<{
  currentUserId: string;
  labelledBy: string;
  members: readonly OrganizationMemberSummary[];
}>) {
  return (
    <ul aria-labelledby={labelledBy} className="space-y-2">
      {members.map((member) => {
        const role = isOrganizationRole(member.role)
          ? TEAM_ROLE_FOR[member.role]
          : null;
        return (
          <li
            className="flex items-center justify-between rounded-md border p-2"
            key={member.userId ?? member.identifier ?? member.role}
          >
            <MemberAvatarInfo
              isCurrentUser={member.userId === currentUserId}
              user={toBasicUser(member)}
            />
            {role ? (
              <RoleSelect disabled onValueChange={ignore} value={role} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The team role whose shipped label names each organization role. */
const TEAM_ROLE_FOR: Readonly<Record<OrganizationRole, TeamRole>> = {
  [OrganizationRole.Owner]: TeamRole.Owner,
  [OrganizationRole.Admin]: TeamRole.Admin,
  [OrganizationRole.Member]: TeamRole.Member,
};

function toBasicUser(member: {
  userId: string | null;
  identifier: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
}): BasicUser {
  return {
    id: member.userId ?? "",
    email: member.identifier ?? "",
    firstName: member.firstName,
    lastName: member.lastName,
    avatarUrl: member.imageUrl,
  };
}

function ignore(): void {
  // The roster is read-only: the seeded people are rows, not Clerk members.
}
