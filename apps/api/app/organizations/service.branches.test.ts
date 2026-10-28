/**
 * ISS-11280 branch coverage for organizationsService.
 *
 * Covers: `toOrganization`'s null-row branch, `findOrCreateByClerkId`'s
 * existing-vs-create fork, its payload-vs-Clerk-API fork, both `?? clerkOrgId`
 * slug fallbacks, and the P2002-race retry (found vs. still-missing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "@/__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { getOrganization: vi.fn() },
}));

import { clerkService } from "@/lib/auth/clerk-service";
import { organizationsService } from "./service";

const CLERK_ORG_ID = "clerk_org_1";
const EXISTING_IDENTITY = { id: "org-1", clerkId: CLERK_ORG_ID };
const CREATED_ROW = {
  id: "org-2",
  clerkId: CLERK_ORG_ID,
  name: "Created Org",
  slug: "created-org",
  active: true,
  settings: {},
  searchIncludeTranscripts: false,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function p2002Error() {
  return { code: "P2002", meta: { target: ["clerkId"] } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("organizationsService.toOrganization", () => {
  it("returns null for a null row", () => {
    expect(organizationsService.toOrganization(null)).toBeNull();
  });
});

describe("organizationsService.findOrCreateByClerkId", () => {
  it("returns the existing identity without creating a row", async () => {
    const findUnique = vi.fn().mockResolvedValue(EXISTING_IDENTITY);
    const create = vi.fn();
    mockWithDbCall({ organization: { findUnique, create } });

    const result =
      await organizationsService.findOrCreateByClerkId(CLERK_ORG_ID);

    expect(result).toEqual(EXISTING_IDENTITY);
    expect(findUnique).toHaveBeenCalledWith({
      where: { clerkId: CLERK_ORG_ID },
      select: { id: true, clerkId: true },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates from the webhook payload's slug when present", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(CREATED_ROW);
    mockWithDbCall({ organization: { findUnique, create } });

    const result = await organizationsService.findOrCreateByClerkId(
      CLERK_ORG_ID,
      { name: "Payload Org", slug: "payload-slug" }
    );

    expect(result).toEqual({
      id: CREATED_ROW.id,
      clerkId: CREATED_ROW.clerkId,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clerkId: CLERK_ORG_ID,
          name: "Payload Org",
          slug: "payload-slug",
        }),
      })
    );
    expect(clerkService.getOrganization).not.toHaveBeenCalled();
  });

  it("falls back to clerkOrgId as the slug when the payload's slug is null", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(CREATED_ROW);
    mockWithDbCall({ organization: { findUnique, create } });

    await organizationsService.findOrCreateByClerkId(CLERK_ORG_ID, {
      name: "Payload Org",
      slug: null,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: CLERK_ORG_ID }),
      })
    );
  });

  it("fetches from Clerk and uses its slug when no payload is given", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(CREATED_ROW);
    mockWithDbCall({ organization: { findUnique, create } });
    vi.mocked(clerkService.getOrganization).mockResolvedValue({
      id: CLERK_ORG_ID,
      name: "Clerk Org",
      slug: "clerk-slug",
      imageUrl: null,
    });

    await organizationsService.findOrCreateByClerkId(CLERK_ORG_ID);

    expect(clerkService.getOrganization).toHaveBeenCalledWith(CLERK_ORG_ID);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Clerk Org",
          slug: "clerk-slug",
        }),
      })
    );
  });

  it("falls back to clerkOrgId as the slug when Clerk's org has no slug", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(CREATED_ROW);
    mockWithDbCall({ organization: { findUnique, create } });
    vi.mocked(clerkService.getOrganization).mockResolvedValue({
      id: CLERK_ORG_ID,
      name: "Clerk Org",
      slug: null,
      imageUrl: null,
    });

    await organizationsService.findOrCreateByClerkId(CLERK_ORG_ID);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: CLERK_ORG_ID }),
      })
    );
  });

  it("re-reads the row and returns it when create loses a P2002 race", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(EXISTING_IDENTITY);
    const create = vi.fn().mockRejectedValue(p2002Error());
    mockWithDbCall({ organization: { findUnique, create } });

    const result = await organizationsService.findOrCreateByClerkId(
      CLERK_ORG_ID,
      { name: "Payload Org", slug: "payload-slug" }
    );

    expect(result).toEqual(EXISTING_IDENTITY);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("rethrows the P2002 error when the retried lookup still finds nothing", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const error = p2002Error();
    const create = vi.fn().mockRejectedValue(error);
    mockWithDbCall({ organization: { findUnique, create } });

    await expect(
      organizationsService.findOrCreateByClerkId(CLERK_ORG_ID, {
        name: "Payload Org",
        slug: "payload-slug",
      })
    ).rejects.toBe(error);
  });

  it("rethrows a non-P2002 create error without retrying the lookup", async () => {
    const findUnique = vi.fn().mockResolvedValueOnce(null);
    const error = { code: "P2010" };
    const create = vi.fn().mockRejectedValue(error);
    mockWithDbCall({ organization: { findUnique, create } });

    await expect(
      organizationsService.findOrCreateByClerkId(CLERK_ORG_ID, {
        name: "Payload Org",
        slug: "payload-slug",
      })
    ).rejects.toBe(error);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("organizationsService.isActive", () => {
  it.each([
    ["an active row", { active: true }, true],
    ["a deactivated row", { active: false }, false],
    ["no row", null, false],
  ])("answers for %s", async (_label, row, expected) => {
    const findUnique = vi.fn().mockResolvedValue(row);
    mockWithDbCall({ organization: { findUnique } });

    await expect(organizationsService.isActive("org-1")).resolves.toBe(
      expected
    );
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "org-1" },
      select: { active: true },
    });
  });
});
