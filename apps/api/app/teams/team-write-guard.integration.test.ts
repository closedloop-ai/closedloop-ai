import { TeamRole } from "@repo/api/src/types/teams";
import { withDb } from "@repo/database";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClerkOrgRoleFixture } from "@/__tests__/utils/auth-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  authorizeTeamScopeRead,
  TeamScopeAuthorization,
} from "@/lib/team-scope-policy";

/**
 * ISS-12644 AC-004: the team write routes, driven through their real guard
 * (`requireTeamRole`), real `teamsService` and a real database, for each actor
 * the AC names. Only the session wrapper (which supplies the caller) and the
 * Clerk role provider are replaced. Every refusal also asserts that nothing was
 * written. The read half drives `authorizeTeamScopeRead` against the same rows.
 */
const mocks = vi.hoisted(() => {
  const caller = { id: "", organizationId: "" };
  return {
    caller,
    getOrganizationMembershipRole: vi.fn(),
    passthroughAuth:
      (handler: (...args: unknown[]) => Promise<Response>) =>
      (request: unknown, context: { params: Promise<unknown> }) =>
        handler(
          {
            authMethod: "session",
            clerkOrgId: "clerk-org",
            clerkUserId: "clerk-user",
            user: caller,
          },
          request,
          context.params
        ),
  };
});

vi.mock("@/lib/auth/with-auth", () => ({ withAuth: mocks.passthroughAuth }));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: mocks.passthroughAuth,
}));
vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
}));

import { POST as addMember } from "./[teamId]/members/route";
import { DELETE as deleteTeam, PUT as updateTeam } from "./[teamId]/route";

const tracker = createCommittedTestOrganizationTracker();
afterEach(() => tracker.cleanup());
beforeEach(() => {
  mocks.getOrganizationMembershipRole.mockResolvedValue(
    ClerkOrgRoleFixture.Member
  );
});
const describeWithDatabase = process.env.DATABASE_URL
  ? describe
  : describe.skip;

describeWithDatabase("team write route guards (ISS-12644 AC-004)", () => {
  it.each([
    ["admin", 200],
    ["legacyOwner", 200],
    ["member", 403],
    ["nonmember", 403],
    ["removed", 403],
    ["crossOrg", 404],
  ] as const)("renames the team as %s → %i", async (actor, status) => {
    const fixture = await seed();
    act(fixture, actor);
    const response = await updateTeam(
      request("PUT", { name: "Renamed" }),
      params({ teamId: fixture.teamId })
    );
    expect(response.status).toBe(status);
    expect(await teamName(fixture.teamId)).toBe(
      status === 200 ? "Renamed" : "Original"
    );
  });

  it.each([
    ["member", 403],
    ["nonmember", 403],
    ["removed", 403],
    ["crossOrg", 404],
    ["admin", 200],
  ] as const)("adds a member as %s → %i", async (actor, status) => {
    const fixture = await seed();
    act(fixture, actor);
    const response = await addMember(
      request("POST", { userId: fixture.users.candidate }),
      params({ teamId: fixture.teamId })
    );
    expect(response.status).toBe(status);
    expect(await membership(fixture.teamId, fixture.users.candidate)).toBe(
      status === 200
    );
  });

  it("deletes the team only for its legacy owner", async () => {
    const fixture = await seed();
    for (const actor of ["admin", "member", "removed", "crossOrg"] as const) {
      act(fixture, actor);
      const refused = await deleteTeam(
        request("DELETE"),
        params({ teamId: fixture.teamId })
      );
      expect([403, 404]).toContain(refused.status);
      expect(await teamName(fixture.teamId)).toBe("Original");
    }
    act(fixture, "legacyOwner");
    const deleted = await deleteTeam(
      request("DELETE"),
      params({ teamId: fixture.teamId })
    );
    expect(deleted.status).toBe(200);
    expect(await teamName(fixture.teamId)).toBeNull();
  });

  it("decides writes by team role alone when the role provider fails", async () => {
    const fixture = await seed();
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("provider unavailable")
    );
    act(fixture, "nonmember");
    const refused = await updateTeam(
      request("PUT", { name: "Renamed" }),
      params({ teamId: fixture.teamId })
    );
    expect(refused.status).toBe(403);
    expect(await teamName(fixture.teamId)).toBe("Original");
    act(fixture, "admin");
    const allowed = await updateTeam(
      request("PUT", { name: "Renamed" }),
      params({ teamId: fixture.teamId })
    );
    expect(allowed.status).toBe(200);
    expect(mocks.getOrganizationMembershipRole).not.toHaveBeenCalled();
  });

  it("authorizes team-scoped reads against persisted membership", async () => {
    const fixture = await seed();
    const read = (actor: Actor) =>
      authorizeTeamScopeRead({
        organizationId:
          actor === "crossOrg" ? fixture.foreignOrganizationId : fixture.orgId,
        userId: fixture.users[actor],
        clerkOrgId: "clerk-org",
        clerkUserId: "clerk-user",
        teamId: fixture.teamId,
        requiresTeamScope: true,
      });
    expect(await read("member")).toBe(TeamScopeAuthorization.Allowed);
    expect(await read("removed")).toBe(TeamScopeAuthorization.Denied);
    expect(await read("nonmember")).toBe(TeamScopeAuthorization.Denied);
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Admin
    );
    expect(await read("crossOrg")).toBe(TeamScopeAuthorization.Denied);
    expect(await read("nonmember")).toBe(TeamScopeAuthorization.Allowed);
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Owner
    );
    expect(await read("nonmember")).toBe(TeamScopeAuthorization.Allowed);
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("provider unavailable")
    );
    expect(await read("nonmember")).toBe(TeamScopeAuthorization.Unresolved);
    expect(await read("member")).toBe(TeamScopeAuthorization.Allowed);
  });
});

type Actor =
  | "admin"
  | "legacyOwner"
  | "member"
  | "nonmember"
  | "removed"
  | "crossOrg";
type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const orgId = await tracker.create();
  const foreignOrganizationId = await tracker.create();
  const [admin, legacyOwner, member, nonmember, removed, candidate, crossOrg] =
    await Promise.all([
      createTestUser(orgId),
      createTestUser(orgId),
      createTestUser(orgId),
      createTestUser(orgId),
      createTestUser(orgId),
      createTestUser(orgId),
      createTestUser(foreignOrganizationId),
    ]);
  const team = await withDb((db) =>
    db.team.create({
      data: {
        organizationId: orgId,
        name: "Original",
        slug: `team-${admin.id}`,
        members: {
          create: [
            { userId: admin.id, role: TeamRole.Admin },
            { userId: legacyOwner.id, role: TeamRole.Owner },
            { userId: member.id, role: TeamRole.Member },
            { userId: removed.id, role: TeamRole.Member },
          ],
        },
      },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.teamMember.deleteMany({ where: { teamId: team.id, userId: removed.id } })
  );
  return {
    orgId,
    foreignOrganizationId,
    teamId: team.id,
    users: {
      admin: admin.id,
      legacyOwner: legacyOwner.id,
      member: member.id,
      nonmember: nonmember.id,
      removed: removed.id,
      candidate: candidate.id,
      crossOrg: crossOrg.id,
    },
  };
}
function act(fixture: Fixture, actor: Actor): void {
  mocks.caller.id = fixture.users[actor];
  mocks.caller.organizationId =
    actor === "crossOrg" ? fixture.foreignOrganizationId : fixture.orgId;
}
function request(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/teams/team", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function params<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}
async function teamName(teamId: string): Promise<string | null> {
  const team = await withDb((db) =>
    db.team.findUnique({ where: { id: teamId }, select: { name: true } })
  );
  return team?.name ?? null;
}
async function membership(teamId: string, userId: string): Promise<boolean> {
  return (
    (await withDb((db) => db.teamMember.count({ where: { teamId, userId } }))) >
    0
  );
}
