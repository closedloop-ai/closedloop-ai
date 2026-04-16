/**
 * Unit tests for documentsService.batchFetchDocumentTitles method.
 *
 * Tests org-scoped slug-to-title lookups with mocked database.
 */
import { vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import { withDb } from "@repo/database";
import { documentsService } from "@/app/documents/service";

describe("documentsService.batchFetchDocumentTitles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("slugs that exist returns correct mapping", async () => {
    const mockDb = {
      document: {
        findMany: vi.fn().mockResolvedValue([
          { slug: "prd-abc", title: "My PRD" },
          { slug: "plan-xyz", title: "My Plan" },
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
    expect(mockDb.document.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        slug: { in: ["prd-abc", "plan-xyz"] },
      },
      select: { slug: true, title: true },
    });
  });

  it("slugs that do not exist are omitted from result", async () => {
    const mockDb = {
      document: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ slug: "prd-abc", title: "My PRD" }]),
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
      document: {
        findMany: vi.fn(),
      },
    };
    mockWithDbCall(mockDb);

    await expect(
      documentsService.batchFetchDocumentTitles("org-1", slugs)
    ).rejects.toThrow("batchFetchDocumentTitles: too many slugs");
    expect(mockDb.document.findMany).not.toHaveBeenCalled();
  });

  it("slugs from a different organization are absent from returned map", async () => {
    // Only org-1's artifacts are returned; org-2 artifacts are not
    // because the query is scoped to organizationId: "org-1"
    const mockDb = {
      document: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ slug: "prd-abc", title: "Org 1 PRD" }]),
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
    expect(mockDb.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-1" }),
      })
    );
  });
});
