/**
 * Unit tests for GET /api/cron/cleanup-loop-state.
 *
 * Verifies the loop-state retention sweep:
 * (a) no purgeable loops → 200 and deleteLoopState is never called
 * (b) terminal loops past the horizon → each S3 prefix is deleted and stamped
 *     s3StateCleanedAt so later runs skip it
 * (c) a delete failure for one loop is isolated — the rest still purge, the
 *     failed loop is NOT stamped, and the route still returns 200
 * (d) the candidate query filters on terminal status, an unset clean marker, and
 *     a non-null s3StateKey
 * (e) a missing/invalid CRON_SECRET bearer short-circuits before any query
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const { mockWithDb, mockFindMany, mockUpdateMany, mockDeleteLoopState } =
  vi.hoisted(() => ({
    mockWithDb: vi.fn(),
    mockFindMany: vi.fn(),
    mockUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
    mockDeleteLoopState: vi.fn().mockResolvedValue(0),
  }));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@repo/database", () => ({
  withDb: mockWithDb,
  LoopStatus: {
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
    TIMED_OUT: "TIMED_OUT",
  },
}));

vi.mock("@/lib/loops/loop-state", () => ({
  deleteLoopState: mockDeleteLoopState,
  getLoopPrefix: (orgId: string, loopId: string) => `${orgId}/loops/${loopId}/`,
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { GET } from "@/app/cron/cleanup-loop-state/route";

function makeRequest(token = "test-cron-secret"): Request {
  return new Request("http://localhost/api/cron/cleanup-loop-state", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET /api/cron/cleanup-loop-state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockDeleteLoopState.mockResolvedValue(0);
    // withDb(cb) runs the callback against a fake Prisma client.
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({ loop: { findMany: mockFindMany, updateMany: mockUpdateMany } })
    );
  });

  afterEach(() => {
    process.env.CRON_SECRET = undefined;
  });

  it("(a) returns 200 without deleting when no loops are purgeable", async () => {
    mockFindMany.mockResolvedValue([]);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("no loop state");
    expect(mockDeleteLoopState).not.toHaveBeenCalled();
  });

  it("(b) deletes each loop's prefix and stamps s3StateCleanedAt", async () => {
    mockFindMany.mockResolvedValue([
      { id: "loop-1", organizationId: "org-1" },
      { id: "loop-2", organizationId: "org-2" },
    ]);
    mockDeleteLoopState.mockResolvedValue(3);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockDeleteLoopState).toHaveBeenCalledWith("org-1/loops/loop-1/");
    expect(mockDeleteLoopState).toHaveBeenCalledWith("org-2/loops/loop-2/");
    // Two purges → two stamping updates, each setting s3StateCleanedAt.
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loop-1", organizationId: "org-1" },
        data: expect.objectContaining({ s3StateCleanedAt: expect.any(Date) }),
      })
    );
  });

  it("(c) isolates a per-loop delete failure and does not stamp it", async () => {
    mockFindMany.mockResolvedValue([
      { id: "loop-1", organizationId: "org-1" },
      { id: "loop-2", organizationId: "org-2" },
    ]);
    mockDeleteLoopState
      .mockRejectedValueOnce(new Error("AccessDenied"))
      .mockResolvedValueOnce(2);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    // Only the successful loop is stamped; the failed one retries next run.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loop-2", organizationId: "org-2" },
      })
    );
  });

  it("(d) queries only terminal, unpurged loops with S3 state", async () => {
    mockFindMany.mockResolvedValue([]);

    await GET(makeRequest());

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"] },
          s3StateKey: { not: null },
          s3StateCleanedAt: null,
        }),
      })
    );
  });

  it("(e) rejects an invalid CRON_SECRET before querying", async () => {
    const response = await GET(makeRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
