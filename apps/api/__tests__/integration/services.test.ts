import { database } from "@repo/database";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import {
  cleanupTestDatabase,
  createTestOrganization,
  disconnectTestDatabase,
  setupTestDatabase,
  withTestTransaction,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const hasDatabase = !!process.env.DATABASE_URL;

describe.skipIf(!hasDatabase)("Users Service Integration", () => {
  let testOrgId: string;

  // Setup once per suite, not per test (OPTIMIZATION)
  beforeAll(async () => {
    await setupTestDatabase();
    // Create organization ONCE and cache the ID
    testOrgId = await createTestOrganization();
  });

  // Clean only user data, keep org cached (OPTIMIZATION)
  afterEach(async () => {
    // Selective cleanup: only delete data created in tests
    await database.user.deleteMany({ where: { organizationId: testOrgId } });
    // Don't delete organization - reuse across tests
  });

  // Full cleanup only at end of suite
  afterAll(async () => {
    await cleanupTestDatabase();
    await disconnectTestDatabase();
  });

  it("creates and finds user by clerkId", async () => {
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

  it("finds users by organization", async () => {
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

  it("updates user data", async () => {
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

  it("deactivates user (soft delete)", async () => {
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

  // ALTERNATIVE: Transaction-based isolation (no cleanup needed)
  it("creates user with auto-rollback", async () => {
    await withTestTransaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          organizationId: testOrgId,
          clerkId: "clerk_tx_test",
          email: "tx@example.com",
          firstName: "TX",
          lastName: "Test",
          role: "ENGINEER",
          active: true,
        },
      });

      expect(user.email).toBe("tx@example.com");
      // No cleanup needed - transaction rolls back automatically
    });

    // Verify rollback - user should not exist
    const found = await database.user.findFirst({
      where: { clerkId: "clerk_tx_test" },
    });
    expect(found).toBeNull();
  });
});

describe.skipIf(!hasDatabase)("Organizations Service Integration", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await cleanupTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it("creates and finds organization by clerkId", async () => {
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

  it("updates organization data", async () => {
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
