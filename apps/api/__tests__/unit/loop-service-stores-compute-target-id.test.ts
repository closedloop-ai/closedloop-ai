/**
 * T-6.2a — loopsService.create stores computeTargetId at creation time
 *
 * Verifies that when a loop is created with a computeTargetId, the value is
 * passed through to the Prisma db.loop.create() call. This is the immutable
 * anchor that prevents in-flight loops from being affected by later preference changes.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
  },
}));

// withDb mock — spies on loop.create to capture the call args
const loopCreateSpy = vi.fn();
const loopCountSpy = vi.fn().mockResolvedValue(0);

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          count: loopCountSpy,
          create: loopCreateSpy,
          findUnique: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        loopEvent: { create: vi.fn() },
        organization: {
          findUnique: vi.fn().mockResolvedValue({ settings: null }),
        },
      })
    ),
    { tx: vi.fn() }
  ),
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";

beforeEach(() => {
  vi.clearAllMocks();
  loopCountSpy.mockResolvedValue(0);
});

describe("loopsService.create — stores computeTargetId at creation time", () => {
  it("passes computeTargetId from CreateLoopRequest through to db.loop.create()", async () => {
    loopCreateSpy.mockResolvedValue({
      id: "loop-1",
      status: "PENDING",
      command: "PLAN",
      computeTargetId: "target-1",
    });

    await loopsService.create("org-1", "user-1", {
      command: "PLAN",
      computeTargetId: "target-1",
    } as any);

    expect(loopCreateSpy).toHaveBeenCalledOnce();
    const createData = loopCreateSpy.mock.calls[0][0].data;
    expect(createData.computeTargetId).toBe("target-1");
  });

  it("stores computeTargetId as null when not provided in CreateLoopRequest", async () => {
    loopCreateSpy.mockResolvedValue({
      id: "loop-2",
      status: "PENDING",
      command: "PLAN",
      computeTargetId: null,
    });

    await loopsService.create("org-1", "user-1", {
      command: "PLAN",
    } as any);

    expect(loopCreateSpy).toHaveBeenCalledOnce();
    const createData = loopCreateSpy.mock.calls[0][0].data;
    expect(createData.computeTargetId).toBeNull();
  });
});
