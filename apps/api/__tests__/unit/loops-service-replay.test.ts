import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { ReplayDetectedError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";

const mockWithDb = withDb as unknown as Mock;

describe("loopsService.addEvent replay handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates duplicate system events by returning false", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue({ status: "RUNNING" });
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({ id: "evt-1" })
      .mockRejectedValueOnce(
        Object.assign(new Error("Unique violation"), { code: "P2002" })
      );

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: { findUnique: mockFindUnique },
        loopEvent: { create: mockCreate },
      })
    );

    const event = {
      type: "output",
      data: {
        chunk: "hello",
        timestamp: "2026-02-17T00:00:00.000Z",
      },
    };

    const first = await loopsService.addEvent("loop-1", "org-1", event);
    const second = await loopsService.addEvent("loop-1", "org-1", event);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("throws ReplayDetectedError for duplicate runner events", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue({ status: "RUNNING" });
    const mockCreate = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Unique violation"), { code: "P2002" })
      );

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: { findUnique: mockFindUnique },
        loopEvent: { create: mockCreate },
      })
    );

    await expect(
      loopsService.addEvent(
        "loop-1",
        "org-1",
        {
          type: "output",
          data: { chunk: "hello", timestamp: "2026-02-17T00:00:00.000Z" },
        },
        { tokenJti: "jti-1", nonce: "11111111-1111-4111-8111-111111111111" }
      )
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });
});
