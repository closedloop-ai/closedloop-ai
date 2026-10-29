import { OrganizationRole } from "@repo/api/src/types/organization-role";
import { TeamRole } from "@repo/api/src/types/teams";
import { LOCAL_TRUSTED_ORG_ROLE } from "@repo/auth/auth-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Membership = { teamId: string; role: string };
type UserRow = {
  id: string;
  clerkId: string;
  createdAt: Date;
  memberships: Membership[];
};

/**
 * An in-memory org with Prisma's own semantics for the two reads the roster
 * makes: the first team by `createdAt`, and each user's memberships filtered by
 * the `where` the roster actually passes (an absent filter constrains nothing).
 */
const store = vi.hoisted(() => ({
  teams: [] as { id: string; createdAt: Date }[],
  users: [] as UserRow[],
}));

vi.mock("@repo/database", () => ({
  withDb: (run: (client: unknown) => unknown) =>
    run({
      team: {
        findFirst: () =>
          Promise.resolve(
            [...store.teams].sort(
              (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
            )[0] ?? null
          ),
      },
      user: {
        findMany: (args: {
          select: {
            teamMemberships: {
              where: { teamId?: string; id?: { in: string[] } };
            };
          };
        }) => {
          const where = args.select.teamMemberships.where;
          return Promise.resolve(
            store.users.map((user) => ({
              id: user.id,
              clerkId: user.clerkId,
              email: `${user.clerkId}@acmeco.example`,
              firstName: user.clerkId,
              lastName: null,
              avatarUrl: null,
              createdAt: user.createdAt,
              updatedAt: user.createdAt,
              teamMemberships: user.memberships
                .filter(
                  (membership) =>
                    (where.teamId === undefined ||
                      membership.teamId === where.teamId) &&
                    where.id?.in.length !== 0
                )
                .map(({ role }) => ({ role })),
            }))
          );
        },
      },
    }),
}));

import { listSeededRoster } from "../seeded-roster";

const HOME = "home-team";
const LATER = "later-team";
const SIGNED_IN = "user_e2e_local_trusted";

function user(clerkId: string, memberships: Membership[]): UserRow {
  return {
    id: `id-${clerkId}`,
    clerkId,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    memberships,
  };
}

function rolesOf(roster: Awaited<ReturnType<typeof listSeededRoster>>) {
  return Object.fromEntries(roster.map(({ userId, role }) => [userId, role]));
}

beforeEach(() => {
  store.teams = [
    { id: HOME, createdAt: new Date("2026-09-01T00:00:00.000Z") },
    { id: LATER, createdAt: new Date("2026-10-06T00:00:00.000Z") },
  ];
  store.users = [
    user("owner", [{ teamId: HOME, role: TeamRole.Owner }]),
    user(SIGNED_IN, [{ teamId: HOME, role: TeamRole.Admin }]),
    user("member", [{ teamId: HOME, role: TeamRole.Member }]),
    user("teamless", []),
  ];
});

// ISS-12135: a seeded vibe stack's roster comes from its rows, with
// organization roles kept apart from team roles.
describe("listSeededRoster", () => {
  it("names the home team's owner the organization owner and the signed-in person by their session role", async () => {
    const roster = await listSeededRoster({
      clerkOrgId: "org_e2e_local_trusted",
      signedIn: { clerkUserId: SIGNED_IN, role: LOCAL_TRUSTED_ORG_ROLE },
    });

    expect(rolesOf(roster)).toEqual({
      owner: OrganizationRole.Owner,
      [SIGNED_IN]: LOCAL_TRUSTED_ORG_ROLE,
      member: OrganizationRole.Member,
      teamless: OrganizationRole.Member,
    });
    expect(roster[0]).toMatchObject({
      id: "orgmem_id-owner",
      identifier: "owner@acmeco.example",
      imageUrl: null,
    });
  });

  it("keeps organization roles when someone owns a team created later", async () => {
    // whitlockk on #8492: creating a team adds an OWNER membership, which must not
    // promote anyone to organization owner.
    store.users = [
      user("owner", [{ teamId: HOME, role: TeamRole.Owner }]),
      user(SIGNED_IN, [
        { teamId: HOME, role: TeamRole.Admin },
        { teamId: LATER, role: TeamRole.Owner },
      ]),
      user("member", [
        { teamId: HOME, role: TeamRole.Member },
        { teamId: LATER, role: TeamRole.Owner },
      ]),
    ];

    const roster = await listSeededRoster({
      clerkOrgId: "org_e2e_local_trusted",
      signedIn: { clerkUserId: SIGNED_IN, role: LOCAL_TRUSTED_ORG_ROLE },
    });

    expect(rolesOf(roster)).toEqual({
      owner: OrganizationRole.Owner,
      [SIGNED_IN]: LOCAL_TRUSTED_ORG_ROLE,
      member: OrganizationRole.Member,
    });
  });

  it("lists everyone as a member when the organization has no team", async () => {
    store.teams = [];

    const roster = await listSeededRoster({
      clerkOrgId: "org_e2e_local_trusted",
      signedIn: { clerkUserId: SIGNED_IN, role: LOCAL_TRUSTED_ORG_ROLE },
    });

    expect(rolesOf(roster).owner).toBe(OrganizationRole.Member);
    expect(rolesOf(roster)[SIGNED_IN]).toBe(LOCAL_TRUSTED_ORG_ROLE);
  });

  it("gives everyone, the signed-in person included, their home-team role when no session role is given", async () => {
    // A seeded Vercel vibe preview: the adopted person administers the home
    // team the seed's owner owns.
    const roster = await listSeededRoster({
      clerkOrgId: "org_real_clerk",
    });

    expect(rolesOf(roster)).toEqual({
      owner: OrganizationRole.Owner,
      [SIGNED_IN]: OrganizationRole.Admin,
      member: OrganizationRole.Member,
      teamless: OrganizationRole.Member,
    });
  });
});
