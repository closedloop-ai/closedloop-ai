import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { getOrganization: vi.fn() },
}));

import { organizationsService } from "@/app/organizations/service";

const MOCK_ORG_IDENTITY = {
  id: "org-1",
  clerkId: "clerk_org_1",
};

const IDENTITY_SELECT = { id: true, clerkId: true };

describe("organizationsService.findBySlug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the organization identity when slug matches", async () => {
    const mockDb = {
      organization: {
        findUnique: vi.fn().mockResolvedValue(MOCK_ORG_IDENTITY),
      },
    };
    mockWithDbCall(mockDb);

    const result = await organizationsService.findBySlug("test-org");

    expect(mockDb.organization.findUnique).toHaveBeenCalledWith({
      where: { slug: "test-org" },
      select: IDENTITY_SELECT,
    });
    expect(result).toEqual(MOCK_ORG_IDENTITY);
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
      select: IDENTITY_SELECT,
    });
    expect(result).toBeNull();
  });
});
