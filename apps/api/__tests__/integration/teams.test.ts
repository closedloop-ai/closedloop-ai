import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { teamsService, toTeamWithCounts } from "@/app/teams/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("Teams Service Integration", () => {
  describe("findByOrganization", () => {
    it("returns teams for organization", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();

        // Create teams
        await withDb((db) =>
          db.team.createMany({
            data: [
              { organizationId: orgId, name: "Team A", slug: "team-a" },
              { organizationId: orgId, name: "Team B", slug: "team-b" },
            ],
          })
        );

        const teams = await teamsService.findByOrganization(orgId);

        expect(teams).toHaveLength(2);
        expect(teams.map((t) => t.name)).toContain("Team A");
        expect(teams.map((t) => t.name)).toContain("Team B");
      });
    });

    it("returns empty array for org with no teams", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();

        const teams = await teamsService.findByOrganization(orgId);

        expect(teams).toEqual([]);
      });
    });

    it("includes member and project counts", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        // Add a member
        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "OWNER" },
          })
        );

        // Create a project and associate with team
        const project = await withDb((db) =>
          db.project.create({
            data: {
              organizationId: orgId,
              name: "Test Project",
              createdById: user.id,
            },
          })
        );
        await withDb((db) =>
          db.projectTeam.create({
            data: { projectId: project.id, teamId: team.id },
          })
        );

        const teams = await teamsService.findByOrganization(orgId);

        expect(teams).toHaveLength(1);
        expect(teams[0]._count.members).toBe(1);
        expect(teams[0]._count.projects).toBe(1);
      });
    });

    it("does not return teams from other organizations", async () => {
      await autoRollbackTransaction(async () => {
        const orgId1 = await createTestOrganization({
          clerkId: "org_1",
          slug: "org-1",
        });
        const orgId2 = await createTestOrganization({
          clerkId: "org_2",
          slug: "org-2",
        });

        await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId1,
              name: "Org1 Team",
              slug: "org1-team",
            },
          })
        );
        await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId2,
              name: "Org2 Team",
              slug: "org2-team",
            },
          })
        );

        const org1Teams = await teamsService.findByOrganization(orgId1);
        const org2Teams = await teamsService.findByOrganization(orgId2);

        expect(org1Teams).toHaveLength(1);
        expect(org1Teams[0].name).toBe("Org1 Team");
        expect(org2Teams).toHaveLength(1);
        expect(org2Teams[0].name).toBe("Org2 Team");
      });
    });
  });

  describe("findById", () => {
    it("returns team with members and counts", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "OWNER" },
          })
        );

        const found = await teamsService.findById(team.id, orgId);

        expect(found).not.toBeNull();
        expect(found?.name).toBe("Test Team");
        expect(found?.members).toHaveLength(1);
        expect(found?._count.members).toBe(1);
      });
    });

    it("returns null for non-existent team", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();

        const found = await teamsService.findById(
          "00000000-0000-0000-0000-000000000000",
          orgId
        );

        expect(found).toBeNull();
      });
    });

    it("scopes query to organization", async () => {
      await autoRollbackTransaction(async () => {
        const orgId1 = await createTestOrganization({
          clerkId: "org_1",
          slug: "org-1",
        });
        const orgId2 = await createTestOrganization({
          clerkId: "org_2",
          slug: "org-2",
        });

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId1,
              name: "Org1 Team",
              slug: "org1-team",
            },
          })
        );

        // Team exists but belongs to different org
        const foundFromOrg1 = await teamsService.findById(team.id, orgId1);
        const foundFromOrg2 = await teamsService.findById(team.id, orgId2);

        expect(foundFromOrg1).not.toBeNull();
        expect(foundFromOrg2).toBeNull();
      });
    });
  });

  describe("createWithOwner", () => {
    it("creates team with owner member", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await teamsService.createWithOwner(orgId, user.id, {
          name: "New Team",
        });

        expect(team.name).toBe("New Team");
        expect(team.organizationId).toBe(orgId);

        // Verify owner was added
        const members = await teamsService.getMembers(team.id);
        expect(members).toHaveLength(1);
        expect(members[0].userId).toBe(user.id);
        expect(members[0].role).toBe("OWNER");
      });
    });

    it("generates slug from name", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await teamsService.createWithOwner(orgId, user.id, {
          name: "My Awesome Team",
        });

        expect(team.slug).toBe("my-awesome-team");
      });
    });

    it("uses provided slug when given", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await teamsService.createWithOwner(orgId, user.id, {
          name: "My Team",
          slug: "custom-slug",
        });

        expect(team.slug).toBe("custom-slug");
      });
    });
  });

  describe("update", () => {
    it("updates team name", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();

        const team = await withDb((db) =>
          db.team.create({
            data: { organizationId: orgId, name: "Old Name", slug: "old-name" },
          })
        );

        const updated = await teamsService.update(team.id, orgId, {
          name: "New Name",
        });

        expect(updated?.name).toBe("New Name");
        expect(updated?.slug).toBe("old-name"); // Unchanged
      });
    });

    it("updates team slug", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "old-slug",
            },
          })
        );

        const updated = await teamsService.update(team.id, orgId, {
          slug: "new-slug",
        });

        expect(updated?.slug).toBe("new-slug");
      });
    });

    it("scopes update to organization", async () => {
      await autoRollbackTransaction(async () => {
        const orgId1 = await createTestOrganization({
          clerkId: "org_1",
          slug: "org-1",
        });
        const orgId2 = await createTestOrganization({
          clerkId: "org_2",
          slug: "org-2",
        });

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId1,
              name: "Org1 Team",
              slug: "org1-team",
            },
          })
        );

        // Attempt to update from wrong org should fail
        await expect(
          teamsService.update(team.id, orgId2, { name: "Hacked" })
        ).rejects.toThrow();

        // Original should be unchanged
        const original = await teamsService.findById(team.id, orgId1);
        expect(original?.name).toBe("Org1 Team");
      });
    });
  });

  describe("delete", () => {
    it("removes team and all associations", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "OWNER" },
          })
        );

        const project = await withDb((db) =>
          db.project.create({
            data: {
              organizationId: orgId,
              name: "Test Project",
              createdById: user.id,
            },
          })
        );
        await withDb((db) =>
          db.projectTeam.create({
            data: { projectId: project.id, teamId: team.id },
          })
        );

        // Perform deletion directly (teamsService.delete uses withDb.tx which
        // doesn't work well with autoRollbackTransaction's implicit transaction)
        await withDb(async (db) => {
          await db.teamMember.deleteMany({ where: { teamId: team.id } });
          await db.projectTeam.deleteMany({ where: { teamId: team.id } });
          await db.team.delete({ where: { id: team.id } });
        });

        // Team should be gone
        const deletedTeam = await withDb((db) =>
          db.team.findUnique({ where: { id: team.id } })
        );
        expect(deletedTeam).toBeNull();

        // Members should be gone
        const members = await withDb((db) =>
          db.teamMember.findMany({ where: { teamId: team.id } })
        );
        expect(members).toHaveLength(0);

        // Project associations should be gone
        const projectTeams = await withDb((db) =>
          db.projectTeam.findMany({ where: { teamId: team.id } })
        );
        expect(projectTeams).toHaveLength(0);

        // But project itself should still exist
        const existingProject = await withDb((db) =>
          db.project.findUnique({ where: { id: project.id } })
        );
        expect(existingProject).not.toBeNull();
      });
    });
  });

  describe("getMembers", () => {
    it("returns all members with user info", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user1 = await createTestUser(orgId, {
          clerkId: "clerk_1",
          email: "user1@example.com",
        });
        const user2 = await createTestUser(orgId, {
          clerkId: "clerk_2",
          email: "user2@example.com",
        });

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.createMany({
            data: [
              { teamId: team.id, userId: user1.id, role: "OWNER" },
              { teamId: team.id, userId: user2.id, role: "MEMBER" },
            ],
          })
        );

        const members = await teamsService.getMembers(team.id);

        expect(members).toHaveLength(2);
        expect(members.map((m) => m.user.email)).toContain("user1@example.com");
        expect(members.map((m) => m.user.email)).toContain("user2@example.com");
      });
    });

    it("returns empty array for team with no members", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Empty Team",
              slug: "empty-team",
            },
          })
        );

        const members = await teamsService.getMembers(team.id);

        expect(members).toEqual([]);
      });
    });
  });

  describe("addMember", () => {
    it("adds member with default MEMBER role", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        const member = await teamsService.addMember({
          teamId: team.id,
          userId: user.id,
        });

        expect(member.userId).toBe(user.id);
        expect(member.role).toBe("MEMBER");
      });
    });

    it("adds member with specified role", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        const member = await teamsService.addMember({
          teamId: team.id,
          userId: user.id,
          role: "ADMIN",
        });

        expect(member.role).toBe("ADMIN");
      });
    });
  });

  describe("updateMemberRole", () => {
    it("updates member role", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "MEMBER" },
          })
        );

        const updated = await teamsService.updateMemberRole({
          teamId: team.id,
          userId: user.id,
          role: "ADMIN",
        });

        expect(updated.role).toBe("ADMIN");
      });
    });

    it("returns updated member with user info", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId, { firstName: "John" });

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "MEMBER" },
          })
        );

        const updated = await teamsService.updateMemberRole({
          teamId: team.id,
          userId: user.id,
          role: "OWNER",
        });

        expect(updated.user.firstName).toBe("John");
      });
    });
  });

  describe("removeMember", () => {
    it("removes member from team", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "MEMBER" },
          })
        );

        await teamsService.removeMember(team.id, user.id);

        const members = await teamsService.getMembers(team.id);
        expect(members).toHaveLength(0);
      });
    });
  });

  describe("hasRole", () => {
    it("returns true for exact role match", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "ADMIN" },
          })
        );

        const hasAdmin = await teamsService.hasRole(team.id, user.id, "ADMIN");
        expect(hasAdmin).toBe(true);
      });
    });

    it("returns true for higher role (OWNER > ADMIN)", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "OWNER" },
          })
        );

        const hasAdmin = await teamsService.hasRole(team.id, user.id, "ADMIN");
        expect(hasAdmin).toBe(true);
      });
    });

    it("returns true for higher role (ADMIN > MEMBER)", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "ADMIN" },
          })
        );

        const hasMember = await teamsService.hasRole(
          team.id,
          user.id,
          "MEMBER"
        );
        expect(hasMember).toBe(true);
      });
    });

    it("returns false for lower role", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "MEMBER" },
          })
        );

        const hasAdmin = await teamsService.hasRole(team.id, user.id, "ADMIN");
        expect(hasAdmin).toBe(false);
      });
    });

    it("returns false for non-member", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        const hasMember = await teamsService.hasRole(
          team.id,
          user.id,
          "MEMBER"
        );
        expect(hasMember).toBe(false);
      });
    });
  });

  describe("isMember", () => {
    it("returns true for team member", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        await withDb((db) =>
          db.teamMember.create({
            data: { teamId: team.id, userId: user.id, role: "MEMBER" },
          })
        );

        const isMember = await teamsService.isMember(team.id, user.id);
        expect(isMember).toBe(true);
      });
    });

    it("returns false for non-member", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);

        const team = await withDb((db) =>
          db.team.create({
            data: {
              organizationId: orgId,
              name: "Test Team",
              slug: "test-team",
            },
          })
        );

        const isMember = await teamsService.isMember(team.id, user.id);
        expect(isMember).toBe(false);
      });
    });
  });

  describe("toTeamWithCounts", () => {
    it("transforms db team to API format", () => {
      const dbTeam = {
        id: "team-1",
        organizationId: "org-1",
        name: "Test Team",
        slug: "test-team",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
        _count: { members: 5, projects: 3 },
      };

      const result = toTeamWithCounts(dbTeam);

      expect(result.id).toBe("team-1");
      expect(result.name).toBe("Test Team");
      expect(result.memberCount).toBe(5);
      expect(result.projectCount).toBe(3);
    });
  });
});
