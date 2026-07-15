import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { loopsService } from "@/app/loops/service";

const mockWithDb = withDb as unknown as Mock;

describe("loopsService.getEventsSince", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockDb(events: unknown[] = []) {
    const mockFindUnique = vi.fn().mockResolvedValue({ id: "loop-1" });
    const mockFindMany = vi.fn().mockResolvedValue(events);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: { findUnique: mockFindUnique },
        loopEvent: { findMany: mockFindMany },
      })
    );

    return { mockFindUnique, mockFindMany };
  }

  it("strict composite keyset-scans events after the (createdAt, id) cursor, bounded", async () => {
    const since = new Date("2026-07-10T00:00:00.000Z");
    const { mockFindMany } = mockDb();

    await loopsService.getEventsSince(
      "loop-1",
      "org-1",
      since,
      "evt-cursor",
      500
    );

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          loopId: "loop-1",
          OR: [
            { createdAt: { gt: since } },
            { createdAt: since, id: { gt: "evt-cursor" } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 500,
      })
    );
  });

  it("enriches rows with id and storedAt while preserving the DB event type", async () => {
    const createdAt = new Date("2026-07-10T01:02:03.000Z");
    mockDb([
      {
        id: "evt-1",
        type: "progress",
        // A `type` inside data must NOT override the canonical DB type.
        data: {
          type: "spoofed",
          message: "hi",
          timestamp: "2026-07-10T01:02:03.500Z",
        },
        createdAt,
      },
    ]);

    const [event] = await loopsService.getEventsSince(
      "loop-1",
      "org-1",
      new Date("2026-07-10T00:00:00.000Z"),
      "evt-cursor",
      500
    );

    expect(event).toMatchObject({
      id: "evt-1",
      type: "progress",
      message: "hi",
      timestamp: "2026-07-10T01:02:03.500Z",
      storedAt: createdAt.toISOString(),
    });
  });

  it("throws when the loop does not belong to the org", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: { findUnique: vi.fn().mockResolvedValue(null) },
        loopEvent: { findMany: vi.fn() },
      })
    );

    await expect(
      loopsService.getEventsSince(
        "loop-missing",
        "org-1",
        new Date("2026-07-10T00:00:00.000Z"),
        "evt-cursor",
        500
      )
    ).rejects.toThrow("Loop not found: loop-missing");
  });
});
