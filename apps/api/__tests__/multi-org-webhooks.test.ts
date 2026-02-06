import type { OrganizationMembershipJSON } from "@repo/auth/server";
import { vi } from "vitest";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import {
  handleOrganizationMembershipCreated,
  handleOrganizationMembershipDeleted,
  handleUserDeleted,
} from "@/app/webhooks/auth/auth-hooks";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "./utils/db-helpers";

// Mock analytics to avoid actual tracking in tests
vi.mock("@repo/analytics/server", () => ({
  analytics: {
    identify: vi.fn(),
    capture: vi.fn(),
    groupIdentify: vi.fn(),
  },
}));

// Mock clerk-service to avoid actual Clerk API calls
vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganization: vi.fn(),
    getUser: vi.fn(),
  },
}));

import { clerkService } from "@/lib/auth/clerk-service";

/**
 * Build an OrganizationMembershipJSON payload with sensible defaults.
 * Only the fields that vary between tests need to be specified.
 */
function buildMembershipPayload(overrides: {
  id?: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  imageUrl?: string;
  hasImage?: boolean;
  membersCount?: number;
}): OrganizationMembershipJSON {
  const now = Date.now();

  return {
    id: overrides.id ?? `orgmem_${overrides.userId}`,
    object: "organization_membership",
    role: "org:member",
    permissions: [],
    public_metadata: {},
    private_metadata: {},
    created_at: now,
    updated_at: now,
    organization: {
      object: "organization",
      id: overrides.orgId,
      name: overrides.orgName,
      slug: overrides.orgSlug,
      image_url: "",
      has_image: false,
      created_at: now,
      updated_at: now,
      public_metadata: {},
      private_metadata: {},
      max_allowed_memberships: 100,
      admin_delete_enabled: false,
      members_count: overrides.membersCount ?? 1,
    },
    public_user_data: {
      user_id: overrides.userId,
      first_name: overrides.firstName,
      last_name: overrides.lastName,
      image_url: overrides.imageUrl ?? "",
      has_image: overrides.hasImage ?? false,
      identifier: overrides.email,
    },
  };
}

describe("Multi-Org Webhook Handlers", () => {
  describe("handleOrganizationMembershipCreated", () => {
    it("creates per-org user record when user joins organization", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization({
          clerkId: "org_test_123",
          name: "Test Org 1",
          slug: "test-org-1",
        });

        vi.mocked(clerkService.getOrganization).mockResolvedValue({
          id: "org_test_123",
          name: "Test Org 1",
          slug: "test-org-1",
        });

        const payload = buildMembershipPayload({
          orgId: "org_test_123",
          orgName: "Test Org 1",
          orgSlug: "test-org-1",
          userId: "user_clerk_123",
          firstName: "John",
          lastName: "Doe",
          email: "john@example.com",
          imageUrl: "https://example.com/avatar.jpg",
          hasImage: true,
        });

        await handleOrganizationMembershipCreated(payload);

        const createdUser = await usersService.findByClerkIdAndOrg(
          "user_clerk_123",
          orgId
        );

        expect(createdUser).not.toBeNull();
        expect(createdUser?.clerkId).toBe("user_clerk_123");
        expect(createdUser?.organizationId).toBe(orgId);
        expect(createdUser?.email).toBe("john@example.com");
        expect(createdUser?.firstName).toBe("John");
        expect(createdUser?.lastName).toBe("Doe");
        expect(createdUser?.active).toBe(true);
      });
    });

    it("creates organization if it doesn't exist (handles webhook ordering)", async () => {
      await autoRollbackTransaction(async () => {
        vi.mocked(clerkService.getOrganization).mockResolvedValue({
          id: "org_new_456",
          name: "New Org",
          slug: "new-org",
        });

        const payload = buildMembershipPayload({
          orgId: "org_new_456",
          orgName: "New Org",
          orgSlug: "new-org",
          userId: "user_clerk_456",
          firstName: "Jane",
          lastName: "Smith",
          email: "jane@example.com",
        });

        await handleOrganizationMembershipCreated(payload);

        const createdOrg =
          await organizationsService.findByClerkId("org_new_456");
        expect(createdOrg).not.toBeNull();
        expect(createdOrg?.name).toBe("New Org");

        const createdUser = await usersService.findByClerkIdAndOrg(
          "user_clerk_456",
          createdOrg!.id
        );
        expect(createdUser).not.toBeNull();
        expect(createdUser?.email).toBe("jane@example.com");
      });
    });

    it("is idempotent when called multiple times for same membership", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization({
          clerkId: "org_test_789",
          name: "Test Org",
          slug: "test-org",
        });

        vi.mocked(clerkService.getOrganization).mockResolvedValue({
          id: "org_test_789",
          name: "Test Org",
          slug: "test-org",
        });

        const payload = buildMembershipPayload({
          orgId: "org_test_789",
          orgName: "Test Org",
          orgSlug: "test-org",
          userId: "user_clerk_789",
          firstName: "Alice",
          lastName: "Johnson",
          email: "alice@example.com",
        });

        await handleOrganizationMembershipCreated(payload);
        await handleOrganizationMembershipCreated(payload);

        const users = await usersService.findByOrganization(orgId);
        const matchingUsers = users.filter(
          (u) => u.clerkId === "user_clerk_789"
        );
        expect(matchingUsers.length).toBe(1);
        expect(matchingUsers[0].email).toBe("alice@example.com");
      });
    });
  });

  describe("handleOrganizationMembershipDeleted", () => {
    it("deactivates user only in the specific organization", async () => {
      await autoRollbackTransaction(async () => {
        const org1Id = await createTestOrganization({
          clerkId: "org_multi_1",
          name: "Org 1",
          slug: "org-1",
        });

        const org2Id = await createTestOrganization({
          clerkId: "org_multi_2",
          name: "Org 2",
          slug: "org-2",
        });

        await usersService.create({
          clerkId: "user_multi_test",
          organizationId: org1Id,
          email: "multi@example.com",
          firstName: "Multi",
          lastName: "User",
        });

        await usersService.create({
          clerkId: "user_multi_test",
          organizationId: org2Id,
          email: "multi@example.com",
          firstName: "Multi",
          lastName: "User",
        });

        const payload = buildMembershipPayload({
          orgId: "org_multi_1",
          orgName: "Org 1",
          orgSlug: "org-1",
          userId: "user_multi_test",
          firstName: "Multi",
          lastName: "User",
          email: "multi@example.com",
          membersCount: 0,
        });

        // Ignore Response object (we only care about database side effects)
        await handleOrganizationMembershipDeleted(payload).catch(() => {});

        const userInOrg1 = await usersService.findByClerkIdAndOrg(
          "user_multi_test",
          org1Id
        );
        expect(userInOrg1).not.toBeNull();
        expect(userInOrg1?.active).toBe(false);

        const userInOrg2 = await usersService.findByClerkIdAndOrg(
          "user_multi_test",
          org2Id
        );
        expect(userInOrg2).not.toBeNull();
        expect(userInOrg2?.active).toBe(true);
      });
    });
  });

  describe("handleUserDeleted", () => {
    it("deactivates user across all organizations", async () => {
      await autoRollbackTransaction(async () => {
        const org1Id = await createTestOrganization({
          clerkId: "org_delete_1",
          name: "Delete Test Org 1",
          slug: "delete-org-1",
        });

        const org2Id = await createTestOrganization({
          clerkId: "org_delete_2",
          name: "Delete Test Org 2",
          slug: "delete-org-2",
        });

        await usersService.create({
          clerkId: "user_delete_all",
          organizationId: org1Id,
          email: "deleteall@example.com",
          firstName: "Delete",
          lastName: "All",
        });

        await usersService.create({
          clerkId: "user_delete_all",
          organizationId: org2Id,
          email: "deleteall@example.com",
          firstName: "Delete",
          lastName: "All",
        });

        // Ignore Response object (we only care about database side effects)
        await handleUserDeleted({
          object: "user",
          id: "user_delete_all",
          deleted: true,
        }).catch(() => {});

        const userInOrg1 = await usersService.findByClerkIdAndOrg(
          "user_delete_all",
          org1Id
        );
        expect(userInOrg1).not.toBeNull();
        expect(userInOrg1?.active).toBe(false);

        const userInOrg2 = await usersService.findByClerkIdAndOrg(
          "user_delete_all",
          org2Id
        );
        expect(userInOrg2).not.toBeNull();
        expect(userInOrg2?.active).toBe(false);
      });
    });
  });
});
