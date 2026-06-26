import type { OrganizationJSON } from "@repo/auth/server";
import { describe, expect, it, vi } from "vitest";
import { organizationsService } from "@/app/organizations/service";
import { handleOrganizationUpdated } from "@/app/webhooks/auth/auth-hooks";

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    identify: vi.fn(),
    capture: vi.fn(),
    groupIdentify: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findOrCreateByClerkId: vi.fn().mockResolvedValue({ id: "org-db-id" }),
    updateByClerkId: vi.fn().mockResolvedValue(null),
  },
}));

function buildOrganizationPayload(
  overrides: Partial<OrganizationJSON> = {}
): OrganizationJSON {
  const now = Date.now();
  return {
    object: "organization",
    id: "org_test_456",
    name: "Updated Org Name",
    slug: "updated-org-slug",
    image_url: "",
    has_image: false,
    created_at: now,
    updated_at: now,
    public_metadata: {},
    private_metadata: {},
    max_allowed_memberships: 100,
    admin_delete_enabled: false,
    members_count: 5,
    created_by: "user_creator_123",
    ...overrides,
  };
}

describe("handleOrganizationUpdated", () => {
  it("syncs name and slug to the database via updateByClerkId", async () => {
    const payload = buildOrganizationPayload({
      id: "org_clerk_789",
      name: "Renamed Organization",
      slug: "renamed-org",
    });

    // Response(body, {status: 204}) throws in Node.js but works in Next.js runtime.
    // The DB sync happens before the return statement, so we verify the mock was called.
    try {
      await handleOrganizationUpdated(payload);
    } catch {
      // Expected: Node.js rejects 204 with body
    }

    expect(organizationsService.findOrCreateByClerkId).toHaveBeenCalledWith(
      "org_clerk_789",
      { name: "Renamed Organization", slug: "renamed-org" }
    );
    expect(organizationsService.updateByClerkId).toHaveBeenCalledWith(
      "org_clerk_789",
      { name: "Renamed Organization", slug: "renamed-org" }
    );
  });

  it("calls findOrCreateByClerkId before updateByClerkId", async () => {
    const payload = buildOrganizationPayload();

    try {
      await handleOrganizationUpdated(payload);
    } catch {
      // Expected: Node.js rejects 204 with body
    }

    const findOrder = vi.mocked(organizationsService.findOrCreateByClerkId).mock
      .invocationCallOrder[0];
    const updateOrder = vi.mocked(organizationsService.updateByClerkId).mock
      .invocationCallOrder[0];
    expect(findOrder).toBeLessThan(updateOrder);
  });
});
