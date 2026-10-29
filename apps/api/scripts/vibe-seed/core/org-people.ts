import { TeamRole } from "@repo/api/src/types/teams";
import { withDb } from "@repo/database";
import { teamsService } from "@/app/teams/service";
import { usersService } from "@/app/users/service";
import { gitHubPerson } from "../github/store-work";
import type { VibeSeedContext } from "../stage";
import { resolveHomeTeamId } from "./org-setup";
import { vibeSeedAvatar } from "./person-avatars";
import {
  VIBE_GOLDEN_USERS,
  VIBE_SEED_OWNER,
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_TEAMMATES,
  type VibeSeedPerson,
} from "./seed-people";

/**
 * ISS-12056 (Seed quality): the signed-in person's role and GitHub handle, and
 * the owner and teammates as org members on the home team. Users go through
 * `usersService.upsertByClerkIdAndOrg` (the writer the Clerk webhook and
 * `findOrCreateUser` use) and memberships through `teamsService.addMember` and
 * `updateMemberRole` (the /teams/:id/members routes).
 *
 * ISS-12135: the home team is OWNED by the fake-named owner and the signed-in
 * person ADMINISTERS it. The base seed made the signed-in person its owner, so
 * that membership is moved to admin here.
 */
export async function seedOrgPeople(context: VibeSeedContext): Promise<void> {
  const { organizationId } = context;
  await applyProfile(
    context.userId,
    organizationId,
    VIBE_SEED_SIGNED_IN_PERSON
  );
  await connectGitHub(
    context.userId,
    organizationId,
    VIBE_SEED_SIGNED_IN_PERSON
  );
  const teamId = await resolveHomeTeamId(context);
  const owner = await upsertPerson(organizationId, VIBE_SEED_OWNER);
  await ensureTeamRole(teamId, owner, TeamRole.Owner);
  await ensureTeamRole(teamId, context.userId, TeamRole.Admin);
  let added = 0;
  for (const person of VIBE_SEED_TEAMMATES) {
    const userId = await upsertPerson(organizationId, person);
    if (!(await teamsService.getMember(teamId, userId))) {
      await teamsService.addMember({
        teamId,
        userId,
        role: TeamRole.Member,
      });
      added += 1;
    }
  }
  context.log(
    `org people: owner and ${VIBE_SEED_TEAMMATES.length} teammate(s), ${added} added to team ${teamId}`
  );
}

/** The create path leaves `role` alone on an existing row and never sets the GitHub handle. */
async function applyProfile(
  userId: string,
  organizationId: string,
  person: VibeSeedPerson
): Promise<void> {
  await usersService.update(userId, organizationId, {
    role: person.role,
    githubUsername: person.githubUsername,
  });
}

/** Run after GitHub replay, which can materialize more golden-corpus users. */
export async function relabelGoldenUsers(
  context: VibeSeedContext
): Promise<void> {
  for (const person of VIBE_GOLDEN_USERS) {
    await context.prisma.user.updateMany({
      where: {
        organizationId: context.organizationId,
        OR: [{ firstName: person.sourceFirstName }, { email: person.email }],
      },
      data: {
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email,
        avatarUrl: vibeSeedAvatar(person.avatarHandle),
      },
    });
  }
}

/**
 * A seeded person's user row, created through the Clerk webhook's writer with
 * the person's role, GitHub handle and connected GitHub account. Also called
 * before the golden import (ISS-12135), which gives each teammate their own
 * corpus sessions.
 */
export async function upsertPerson(
  organizationId: string,
  person: VibeSeedPerson
): Promise<string> {
  const user = await usersService.upsertByClerkIdAndOrg({
    clerkId: person.clerkId,
    organizationId,
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    avatarUrl: vibeSeedAvatar(person.githubUsername),
    phoneNumber: null,
    role: person.role,
  });
  await applyProfile(user.id, organizationId, person);
  await connectGitHub(user.id, organizationId, person);
  return user.id;
}

/** Add the member with `role`, or move an existing membership to it. */
async function ensureTeamRole(
  teamId: string,
  userId: string,
  role: TeamRole
): Promise<void> {
  const member = await teamsService.getMember(teamId, userId);
  if (!member) {
    await teamsService.addMember({ teamId, userId, role });
    return;
  }
  if (member.role !== role) {
    await teamsService.updateMemberRole({ teamId, userId, role });
  }
}

/**
 * ISS-12135: the person's connected GitHub account, as the GitHub connect flow
 * records it: the seeded corpus's pushes, pull requests and reviews carry the
 * person's handle and GitHub id (`gitHubPerson`), and the product attributes
 * a GitHub author to the org member whose connection holds that id, instead of
 * creating a "<login> GitHub" stand-in user.
 */
async function connectGitHub(
  userId: string,
  organizationId: string,
  person: VibeSeedPerson
): Promise<void> {
  const login = person.githubUsername;
  const identity = {
    githubUserId: String(gitHubPerson(login).id),
    githubNodeId: null,
    login,
    normalizedLogin: login.toLowerCase(),
    avatarUrl: vibeSeedAvatar(login),
    profileUrl: `https://github.com/${login}`,
    revokedAt: null,
  };
  await withDb((db) =>
    db.gitHubUserConnection.upsert({
      where: { organizationId_userId: { organizationId, userId } },
      create: { organizationId, userId, ...identity },
      update: identity,
      select: { id: true },
    })
  );
}
