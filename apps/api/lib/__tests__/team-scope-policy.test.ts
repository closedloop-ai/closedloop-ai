/**
 * ISS-6934 — `authorizeTeamScopeRead` admits BOTH privileged Clerk roles on its
 * org-admin FALLBACK branch.
 *
 * This is the one org-admin consumer whose decision shape differs from the
 * admin-gated routes: the role check is not the first thing the caller hits, it
 * is the escape hatch reached only after team membership has already failed. An
 * org owner who is not on the team must still read team-scoped data, so
 * dropping `org:owner` from `ADMIN_ROLES` would silently narrow this fallback
 * as well as the route gates.
 *
 * `apps/api/app/agent-sessions/team-scope-routes.test.ts` stubs the org-admin gate
 * itself, so it can never reach the role check — hence the Clerk client is
 * stubbed here and the real `org-admin` module runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrganizationMembershipRole: vi.fn(),
  teamsService: { existsInOrganization: vi.fn(), isMember: vi.fn() },
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: mocks.teamsService,
}));

import { ClerkOrgRoleFixture } from "@/__tests__/utils/auth-helpers";
import {
  authorizeTeamScopeRead,
  TeamScopeAuthorization,
} from "@/lib/team-scope-policy";

const NON_MEMBER_REQUEST = {
  organizationId: "org-1",
  userId: "user-1",
  clerkOrgId: "clerk-org-1",
  clerkUserId: "clerk-user-1",
  teamId: "team-1",
  requiresTeamScope: true,
};

describe("authorizeTeamScopeRead — org-admin fallback for a non-member", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.teamsService.existsInOrganization.mockResolvedValue(true);
    // Forces every case below through the org-admin fallback rather than the
    // membership short-circuit, which would never reach ADMIN_ROLES.
    mocks.teamsService.isMember.mockResolvedValue(false);
  });

  it("authorizes a non-member with the org:admin role", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Admin
    );

    await expect(authorizeTeamScopeRead(NON_MEMBER_REQUEST)).resolves.toBe(
      TeamScopeAuthorization.Allowed
    );
    expect(mocks.teamsService.isMember).toHaveBeenCalled();
  });

  it("authorizes a non-member with the org:owner role", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Owner
    );

    await expect(authorizeTeamScopeRead(NON_MEMBER_REQUEST)).resolves.toBe(
      TeamScopeAuthorization.Allowed
    );
    expect(mocks.teamsService.isMember).toHaveBeenCalled();
  });

  it("refuses a non-member with an unprivileged role", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    await expect(authorizeTeamScopeRead(NON_MEMBER_REQUEST)).resolves.toBe(
      TeamScopeAuthorization.Denied
    );
  });

  // ISS-8661: an org-admin fallback that could not be READ is not a refusal.
  // Collapsing it into Denied told a legitimate reader they lack access.
  it("reports an unresolved role as Unresolved, not Denied", async () => {
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("clerk down")
    );

    await expect(authorizeTeamScopeRead(NON_MEMBER_REQUEST)).resolves.toBe(
      TeamScopeAuthorization.Unresolved
    );
  });

  it("does not consult membership or Clerk for a team outside the organization", async () => {
    mocks.teamsService.existsInOrganization.mockResolvedValue(false);
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Admin
    );

    await expect(authorizeTeamScopeRead(NON_MEMBER_REQUEST)).resolves.toBe(
      TeamScopeAuthorization.Denied
    );
    expect(mocks.teamsService.isMember).not.toHaveBeenCalled();
    expect(mocks.getOrganizationMembershipRole).not.toHaveBeenCalled();
  });

  it("admits an existing team member without depending on Clerk availability", async () => {
    mocks.teamsService.isMember.mockResolvedValue(true);
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("clerk down")
    );

    await expect(authorizeTeamScopeRead(NON_MEMBER_REQUEST)).resolves.toBe(
      TeamScopeAuthorization.Allowed
    );
    expect(mocks.getOrganizationMembershipRole).not.toHaveBeenCalled();
  });

  it.each([null, "org:unrecognized-role"])(
    "does not grant the admin fallback for an absent or unknown provider role (%s)",
    async (role) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(role);

      await expect(authorizeTeamScopeRead(NON_MEMBER_REQUEST)).resolves.toBe(
        TeamScopeAuthorization.Denied
      );
    }
  );

  it("requires a team identifier when the request explicitly asks for team scope", async () => {
    await expect(
      authorizeTeamScopeRead({ ...NON_MEMBER_REQUEST, teamId: undefined })
    ).resolves.toBe(TeamScopeAuthorization.Denied);
    expect(mocks.teamsService.existsInOrganization).not.toHaveBeenCalled();
    expect(mocks.getOrganizationMembershipRole).not.toHaveBeenCalled();
  });

  it("leaves an unscoped request to its owning route without an admin lookup", async () => {
    await expect(
      authorizeTeamScopeRead({
        ...NON_MEMBER_REQUEST,
        teamId: undefined,
        requiresTeamScope: false,
      })
    ).resolves.toBe(TeamScopeAuthorization.Allowed);
    expect(mocks.teamsService.existsInOrganization).not.toHaveBeenCalled();
    expect(mocks.getOrganizationMembershipRole).not.toHaveBeenCalled();
  });
});
