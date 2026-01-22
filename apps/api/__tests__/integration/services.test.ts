import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("Users Service Integration", () => {
  it("creates and finds user by clerkId", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      const user = await usersService.create({
        clerkId: "clerk_test_123",
        organizationId: testOrgId,
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe("test@example.com");

      const found = await usersService.findByClerkId("clerk_test_123");
      expect(found).not.toBeNull();
      expect(found?.id).toBe(user.id);
    });
  });

  it("finds users by organization", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      await usersService.create({
        clerkId: "clerk_user_1",
        organizationId: testOrgId,
        email: "user1@example.com",
        firstName: "User",
        lastName: "One",
      });

      await usersService.create({
        clerkId: "clerk_user_2",
        organizationId: testOrgId,
        email: "user2@example.com",
        firstName: "User",
        lastName: "Two",
      });

      const users = await usersService.findByOrganization(testOrgId);
      expect(users.length).toBeGreaterThanOrEqual(2);
      expect(users.map((u) => u.email)).toContain("user1@example.com");
      expect(users.map((u) => u.email)).toContain("user2@example.com");
    });
  });

  it("updates user data", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      const user = await usersService.create({
        clerkId: "clerk_update_test",
        organizationId: testOrgId,
        email: "update@example.com",
        firstName: "Old",
        lastName: "Name",
      });

      const updated = await usersService.update(user.id, {
        firstName: "New",
        lastName: "Name",
      });

      expect(updated.firstName).toBe("New");
      expect(updated.lastName).toBe("Name");
      expect(updated.email).toBe("update@example.com"); // unchanged
    });
  });

  it("deactivates user (soft delete)", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      const user = await usersService.create({
        clerkId: "clerk_delete_test",
        organizationId: testOrgId,
        email: "delete@example.com",
        firstName: "To",
        lastName: "Delete",
      });

      expect(user.active).toBe(true);

      const deactivated = await usersService.deactivate(user.id);
      expect(deactivated.active).toBe(false);
    });
  });

  it("verifies transaction rollback", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();

      await usersService.create({
        clerkId: "clerk_rollback_test",
        organizationId: testOrgId,
        email: "rollback@example.com",
        firstName: "Rollback",
        lastName: "Test",
      });
    });

    // Verify rollback - user should not exist after transaction
    const found = await withDb((db) =>
      db.user.findFirst({
        where: { clerkId: "clerk_rollback_test" },
      })
    );
    expect(found).toBeNull();
  });
});

describe.skipIf(!hasDatabase)("Organizations Service Integration", () => {
  it("creates and finds organization by clerkId", async () => {
    await autoRollbackTransaction(async () => {
      const org = await organizationsService.create({
        clerkId: "org_test_123",
        name: "Test Org",
        slug: "test-org",
      });

      expect(org.id).toBeDefined();
      expect(org.name).toBe("Test Org");

      const found = await organizationsService.findByClerkId("org_test_123");
      expect(found).not.toBeNull();
      expect(found?.id).toBe(org.id);
    });
  });

  it("updates organization data", async () => {
    await autoRollbackTransaction(async () => {
      const org = await organizationsService.create({
        clerkId: "org_update_test",
        name: "Old Name",
        slug: "old-slug",
      });

      const updated = await organizationsService.update(org.id, {
        name: "New Name",
      });

      expect(updated.name).toBe("New Name");
      expect(updated.slug).toBe("old-slug"); // unchanged
    });
  });
});
