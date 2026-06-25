import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { getOrganization: vi.fn() },
}));

import { organizationsService } from "@/app/organizations/service";

const MOCK_ORG = {
  id: "org-1",
  clerkId: "clerk_org_1",
  name: "Test Org",
  slug: "test-org",
  active: true,
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("organizationsService.findBySlug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the organization when slug matches", async () => {
    const mockDb = {
      organization: {
        findUnique: vi.fn().mockResolvedValue(MOCK_ORG),
      },
    };
    mockWithDbCall(mockDb);

    const result = await organizationsService.findBySlug("test-org");

    expect(mockDb.organization.findUnique).toHaveBeenCalledWith({
      where: { slug: "test-org" },
    });
    expect(result).toEqual(MOCK_ORG);
  });

  it("returns null when slug does not match", async () => {
    const mockDb = {
      organization: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDbCall(mockDb);

    const result = await organizationsService.findBySlug("nonexistent");

    expect(mockDb.organization.findUnique).toHaveBeenCalledWith({
      where: { slug: "nonexistent" },
    });
    expect(result).toBeNull();
  });
});
