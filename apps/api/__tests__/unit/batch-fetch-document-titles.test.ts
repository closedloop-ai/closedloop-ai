/**
 * Unit tests for documentsService.batchFetchDocumentTitles method.
 *
 * Tests org-scoped slug-to-title lookups with mocked database.
 */
import { vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

import { withDb } from "@repo/database";
import { documentsService } from "@/app/documents/service";

describe("documentsService.batchFetchDocumentTitles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("slugs that exist returns correct mapping", async () => {
    const mockDb = {
      artifact: {
        findMany: vi.fn().mockResolvedValue([
          { slug: "prd-abc", name: "My PRD" },
          { slug: "plan-xyz", name: "My Plan" },
        ]),
      },
    };
    mockWithDbCall(mockDb);

    const result = await documentsService.batchFetchDocumentTitles("org-1", [
      "prd-abc",
      "plan-xyz",
    ]);

    expect(result).toEqual({
      "prd-abc": "My PRD",
      "plan-xyz": "My Plan",
    });
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        slug: { in: ["prd-abc", "plan-xyz"] },
        type: "DOCUMENT",
      },
      select: { slug: true, name: true },
    });
  });

  it("slugs that do not exist are omitted from result", async () => {
    const mockDb = {
      artifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ slug: "prd-abc", name: "My PRD" }]),
      },
    };
    mockWithDbCall(mockDb);

    const result = await documentsService.batchFetchDocumentTitles("org-1", [
      "prd-abc",
      "does-not-exist",
    ]);

    expect(result).toEqual({ "prd-abc": "My PRD" });
    expect(result).not.toHaveProperty("does-not-exist");
  });

  it("empty input returns empty object without DB query", async () => {
    const result = await documentsService.batchFetchDocumentTitles("org-1", []);

    expect(result).toEqual({});
    expect(withDb).not.toHaveBeenCalled();
  });

  it("input exceeding max slugs throws", async () => {
    const slugs = Array.from({ length: 51 }, (_, i) => `slug-${i}`);
    const mockDb = {
      artifact: {
        findMany: vi.fn(),
      },
    };
    mockWithDbCall(mockDb);

    await expect(
      documentsService.batchFetchDocumentTitles("org-1", slugs)
    ).rejects.toThrow("batchFetchDocumentTitles: too many slugs");
    expect(mockDb.artifact.findMany).not.toHaveBeenCalled();
  });

  it("slugs from a different organization are absent from returned map", async () => {
    // Only org-1's artifacts are returned; org-2 artifacts are not
    // because the query is scoped to organizationId: "org-1"
    const mockDb = {
      artifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ slug: "prd-abc", name: "Org 1 PRD" }]),
      },
    };
    mockWithDbCall(mockDb);

    const result = await documentsService.batchFetchDocumentTitles("org-1", [
      "prd-abc",
      "other-org-slug",
    ]);

    // other-org-slug was not returned by DB (scoped to org-1), so it's absent
    expect(result).toEqual({ "prd-abc": "Org 1 PRD" });
    expect(result).not.toHaveProperty("other-org-slug");
    // Verify the query was org-scoped
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-1" }),
      })
    );
  });
});
