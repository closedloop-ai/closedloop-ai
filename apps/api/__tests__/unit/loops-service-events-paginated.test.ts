import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { loopsService } from "@/app/loops/service";

const mockWithDb = withDb as unknown as Mock;

describe("loopsService.getEventsPaginated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockDbForPaginated(events: unknown[] = [], total = 0) {
    const mockFindUnique = vi.fn().mockResolvedValue({ id: "loop-1" });
    const mockFindMany = vi.fn().mockResolvedValue(events);
    const mockCount = vi.fn().mockResolvedValue(total);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: { findUnique: mockFindUnique },
        loopEvent: { findMany: mockFindMany, count: mockCount },
      })
    );

    return { mockFindMany, mockCount };
  }

  it("defaults to ascending order when sort is not specified", async () => {
    const { mockFindMany } = mockDbForPaginated();

    await loopsService.getEventsPaginated("loop-1", "org-1", {
      type: "error",
      limit: 1,
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "asc" },
      })
    );
  });

  it("uses descending order when sort is 'desc'", async () => {
    const { mockFindMany } = mockDbForPaginated();

    await loopsService.getEventsPaginated("loop-1", "org-1", {
      type: "error",
      limit: 1,
      sort: "desc",
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("throws when loop is not found", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: { findUnique: vi.fn().mockResolvedValue(null) },
        loopEvent: { findMany: vi.fn(), count: vi.fn() },
      })
    );

    await expect(
      loopsService.getEventsPaginated("loop-missing", "org-1", {})
    ).rejects.toThrow("Loop not found: loop-missing");
  });
});
