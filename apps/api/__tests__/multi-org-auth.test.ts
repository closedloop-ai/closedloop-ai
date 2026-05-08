import { keys } from "@repo/database/keys";
import { usersService } from "@/app/users/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "./utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("Multi-Organization Auth Integration", () => {
  it("creates same clerkId user in two orgs with different user IDs", async () => {
    await autoRollbackTransaction(async () => {
      // Create two test organizations
      const orgA = await createTestOrganization({
        clerkId: "org_multi_test_a",
        slug: "multi-org-a",
        name: "Multi Org A",
      });
      const orgB = await createTestOrganization({
        clerkId: "org_multi_test_b",
        slug: "multi-org-b",
        name: "Multi Org B",
      });

      const sharedClerkId = "clerk_shared_user_123";

      // Create same clerkId user in both orgs via upsertByClerkIdAndOrg
      const userInOrgA = await usersService.upsertByClerkIdAndOrg({
        clerkId: sharedClerkId,
        organizationId: orgA,
        email: "shared@example.com",
        firstName: "Shared",
        lastName: "User",
      });

      const userInOrgB = await usersService.upsertByClerkIdAndOrg({
        clerkId: sharedClerkId,
        organizationId: orgB,
        email: "shared@example.com",
        firstName: "Shared",
        lastName: "User",
      });

      // Verify different user IDs
      expect(userInOrgA.id).toBeDefined();
      expect(userInOrgB.id).toBeDefined();
      expect(userInOrgA.id).not.toBe(userInOrgB.id);

      // Verify correct organizationId
      expect(userInOrgA.organizationId).toBe(orgA);
      expect(userInOrgB.organizationId).toBe(orgB);

      // Verify both are active
      expect(userInOrgA.active).toBe(true);
      expect(userInOrgB.active).toBe(true);

      // Verify can find each user by clerkId + org
      const foundA = await usersService.findByClerkIdAndOrg(
        sharedClerkId,
        orgA
      );
      const foundB = await usersService.findByClerkIdAndOrg(
        sharedClerkId,
        orgB
      );

      expect(foundA?.id).toBe(userInOrgA.id);
      expect(foundB?.id).toBe(userInOrgB.id);
    });
  });

  it("deactivates user in one org without affecting other org", async () => {
    await autoRollbackTransaction(async () => {
      // Create two test organizations
      const orgA = await createTestOrganization({
        clerkId: "org_deactivate_test_a",
        slug: "deactivate-org-a",
        name: "Deactivate Org A",
      });
      const orgB = await createTestOrganization({
        clerkId: "org_deactivate_test_b",
        slug: "deactivate-org-b",
        name: "Deactivate Org B",
      });

      const sharedClerkId = "clerk_deactivate_test_456";

      // Create same clerkId user in both orgs
      const userInOrgA = await usersService.upsertByClerkIdAndOrg({
        clerkId: sharedClerkId,
        organizationId: orgA,
        email: "deactivate@example.com",
        firstName: "Deactivate",
        lastName: "Test",
      });

      const userInOrgB = await usersService.upsertByClerkIdAndOrg({
        clerkId: sharedClerkId,
        organizationId: orgB,
        email: "deactivate@example.com",
        firstName: "Deactivate",
        lastName: "Test",
      });

      // Verify both are initially active
      expect(userInOrgA.active).toBe(true);
      expect(userInOrgB.active).toBe(true);

      // Deactivate user in org A only
      await usersService.deactivateByClerkIdAndOrg(sharedClerkId, orgA);

      // Verify org A user is deactivated
      const foundA = await usersService.findByClerkIdAndOrg(
        sharedClerkId,
        orgA
      );
      expect(foundA?.active).toBe(false);

      // Verify org B user remains active
      const foundB = await usersService.findByClerkIdAndOrg(
        sharedClerkId,
        orgB
      );
      expect(foundB?.active).toBe(true);
    });
  });

  it("concurrent upserts return same user ID (idempotency)", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization({
        clerkId: "org_concurrent_test",
        slug: "concurrent-org",
        name: "Concurrent Org",
      });

      const sharedClerkId = "clerk_concurrent_test_789";

      // Run concurrent upserts via Promise.all
      const [user1, user2, user3] = await Promise.all([
        usersService.upsertByClerkIdAndOrg({
          clerkId: sharedClerkId,
          organizationId: testOrgId,
          email: "concurrent@example.com",
          firstName: "Concurrent",
          lastName: "Test",
        }),
        usersService.upsertByClerkIdAndOrg({
          clerkId: sharedClerkId,
          organizationId: testOrgId,
          email: "concurrent@example.com",
          firstName: "Concurrent",
          lastName: "Test",
        }),
        usersService.upsertByClerkIdAndOrg({
          clerkId: sharedClerkId,
          organizationId: testOrgId,
          email: "concurrent@example.com",
          firstName: "Concurrent",
          lastName: "Test",
        }),
      ]);

      // Verify all return same user ID (idempotency)
      expect(user1.id).toBe(user2.id);
      expect(user2.id).toBe(user3.id);
      expect(user1.organizationId).toBe(testOrgId);
    });
  });
});
