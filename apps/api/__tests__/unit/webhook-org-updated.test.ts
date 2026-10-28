import type { OrganizationJSON } from "@repo/auth/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    updateByClerkId: vi.fn().mockResolvedValue(1),
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
  beforeEach(() => {
    vi.mocked(organizationsService.updateByClerkId).mockClear();
    vi.mocked(organizationsService.findOrCreateByClerkId).mockClear();
  });

  it("syncs name and slug to the database via updateByClerkId", async () => {
    const payload = buildOrganizationPayload({
      id: "org_clerk_789",
      name: "Renamed Organization",
      slug: "renamed-org",
      updated_at: 1_700_000_000_000,
    });

    const response = await handleOrganizationUpdated(payload);

    expect(response.status).toBe(204);
    expect(organizationsService.findOrCreateByClerkId).toHaveBeenCalledWith(
      "org_clerk_789",
      { name: "Renamed Organization", slug: "renamed-org" }
    );
    expect(organizationsService.updateByClerkId).toHaveBeenCalledWith(
      "org_clerk_789",
      { name: "Renamed Organization", slug: "renamed-org" },
      new Date(1_700_000_000_000)
    );
  });

  it("calls findOrCreateByClerkId before updateByClerkId", async () => {
    const payload = buildOrganizationPayload();

    await handleOrganizationUpdated(payload);

    const findOrder = vi.mocked(organizationsService.findOrCreateByClerkId).mock
      .invocationCallOrder[0];
    const updateOrder = vi.mocked(organizationsService.updateByClerkId).mock
      .invocationCallOrder[0];
    expect(findOrder).toBeLessThan(updateOrder);
  });

  // ISS-7132: the route verifies the Svix signature and nothing about the body
  // shape, so `updated_at` is typed as a number but not known to be one. An
  // Invalid Date makes Prisma throw, which POST turns into a 500 and Svix then
  // redelivers forever a payload that can never succeed.
  it("skips the mirror write when updated_at is not a usable stamp", async () => {
    const payload = buildOrganizationPayload({ updated_at: Number.NaN });

    const response = await handleOrganizationUpdated(payload);

    expect(response.status).toBe(204);
    expect(organizationsService.updateByClerkId).not.toHaveBeenCalled();
  });
});
