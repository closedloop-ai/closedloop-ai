/**
 * Tests for GET /api/cron/timeout-loops
 *
 * Uses vi.mock to replace withDb with a fake that captures Prisma query args.
 * Each stuck-loop test needs two mockImplementationOnce calls: one for findMany
 * and one for updateMany inside timeoutLoop(). Omitting the second causes
 * "updateMany is not a function".
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---
//
// vi.hoisted() is required for ALL variables referenced inside vi.mock() factories.
// vi.mock() calls are hoisted to the top of the file before any const declarations,
// so factory closures over non-hoisted variables throw ReferenceError.

const {
  mockWithDb,
  mockAddEvent,
  mockStopLoopTask,
  mockScrubContextPackSecrets,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockAddEvent: vi.fn().mockResolvedValue(undefined),
  mockStopLoopTask: vi.fn().mockResolvedValue(undefined),
  mockScrubContextPackSecrets: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    addEvent: mockAddEvent,
  },
}));

vi.mock("@/lib/loops/loop-ecs", () => ({
  stopLoopTask: mockStopLoopTask,
}));

vi.mock("@/lib/loops/loop-state", () => ({
  scrubContextPackSecrets: mockScrubContextPackSecrets,
}));

// withDb is called twice per stuck loop: once for findMany, once for updateMany.
// Use mockImplementationOnce so the first call provides the findMany mock
// and the second call provides the updateMany mock inside timeoutLoop().
// Failing to mock both calls causes "updateMany is not a function".
vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: vi.fn() }),
  LoopStatus: {
    PENDING: "PENDING",
    CLAIMED: "CLAIMED",
    RUNNING: "RUNNING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
    TIMED_OUT: "TIMED_OUT",
  },
}));

// --- Imports (after mocks) ---

import { LoopStatus } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/cron/timeout-loops/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FindManyArgs = { where: { OR: Record<string, unknown>[] } };

function makeRequest(token = "test-secret"): Request {
  return new Request("http://localhost/api/cron/timeout-loops", {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
}

/**
 * Sets up mockWithDb to capture the findMany args and return an empty result,
 * then calls GET and returns the captured args. Callers assert on the returned
 * args directly — no need to repeat the capture boilerplate in each test.
 */
async function captureWhereClause(now: Date): Promise<FindManyArgs> {
  vi.setSystemTime(now);
  let captured: FindManyArgs | undefined;
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      loop: {
        findMany: vi.fn().mockImplementation((args: unknown) => {
          captured = args as FindManyArgs;
          return Promise.resolve([]);
        }),
      },
    })
  );
  await GET(makeRequest());
  if (!captured) {
    throw new Error("findMany was not called");
  }
  return captured;
}

type StuckLoopFixture = {
  id: string;
  organizationId: string;
  status: string;
  containerId: string | null;
  s3StateKey: string | null;
};

/**
 * Mocks both withDb calls needed for a single stuck loop:
 * 1. findMany returning the given loops
 * 2. updateMany returning the given count (default 1)
 *
 * Returns the updateMany mock so callers can assert on its args.
 */
function mockFindAndUpdate(
  loops: StuckLoopFixture[],
  updateCount = 1
): ReturnType<typeof vi.fn> {
  // First withDb call: findMany
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      loop: {
        findMany: vi.fn().mockResolvedValue(loops),
      },
    })
  );

  // Second withDb call: updateMany inside timeoutLoop
  const mockUpdateMany = vi.fn().mockResolvedValue({ count: updateCount });
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      loop: {
        updateMany: mockUpdateMany,
      },
    })
  );

  return mockUpdateMany;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/cron/timeout-loops — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.CRON_SECRET = undefined;
  });

  it("returns 500 when CRON_SECRET is not set", async () => {
    // Empty string is falsy — same code path as missing env var
    process.env.CRON_SECRET = "";
    const request = makeRequest();
    const response = await GET(request);
    expect(response.status).toBe(500);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const request = new Request("http://localhost/api/cron/timeout-loops");
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("returns 401 when Authorization header has wrong token", async () => {
    const request = makeRequest("wrong-secret");
    const response = await GET(request);
    expect(response.status).toBe(401);
  });
});

describe("GET /api/cron/timeout-loops — WHERE clause structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.CRON_SECRET = undefined;
  });

  it("returns 200 with no stuck loops message when findMany returns empty array", async () => {
    const mockUpdateMany = vi.fn();
    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: mockUpdateMany,
        },
      })
    );

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("OK: no stuck loops");
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("RUNNING clause uses activity-based detection with computeTargetId: null", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const activityCutoff = new Date(now.getTime() - 75 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[0]).toEqual({
      status: LoopStatus.RUNNING,
      computeTargetId: null,
      events: { none: { createdAt: { gte: activityCutoff } } },
    });
  });

  it("CLAIMED clause uses createdAt cutoff and computeTargetId: null", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const claimedCutoff = new Date(now.getTime() - 90 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[1]).toEqual({
      status: LoopStatus.CLAIMED,
      computeTargetId: null,
      createdAt: { lt: claimedCutoff },
    });
  });

  it("PENDING clause uses createdAt cutoff and computeTargetId: null", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const pendingCutoff = new Date(now.getTime() - 30 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[2]).toEqual({
      status: LoopStatus.PENDING,
      computeTargetId: null,
      createdAt: { lt: pendingCutoff },
    });
  });

  it("all OR clauses include computeTargetId: null", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const args = await captureWhereClause(now);

    for (const clause of args.where.OR) {
      expect(clause).toHaveProperty("computeTargetId", null);
    }
  });
});

describe("GET /api/cron/timeout-loops — timeoutLoop processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.CRON_SECRET = undefined;
  });

  it("calls updateMany and addEvent for each stuck RUNNING loop", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const stuckLoop: StuckLoopFixture = {
      id: "loop-stuck-1",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
      containerId: null,
      s3StateKey: null,
    };

    const mockUpdateMany = mockFindAndUpdate([stuckLoop]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("OK: timed out 1 loops");

    // Verify updateMany was called with the correct arguments
    expect(mockUpdateMany).toHaveBeenCalledOnce();
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: stuckLoop.id,
          organizationId: stuckLoop.organizationId,
          status: {
            in: [LoopStatus.PENDING, LoopStatus.CLAIMED, LoopStatus.RUNNING],
          },
        }),
        data: expect.objectContaining({
          status: LoopStatus.TIMED_OUT,
          completedAt: now,
        }),
      })
    );

    // Verify addEvent was called for the audit trail
    expect(mockAddEvent).toHaveBeenCalledOnce();
    expect(mockAddEvent).toHaveBeenCalledWith(
      stuckLoop.id,
      stuckLoop.organizationId,
      expect.objectContaining({
        type: "error",
        data: expect.objectContaining({ code: "TIMED_OUT" }),
      })
    );
  });

  it("calls stopLoopTask when the loop has a containerId", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const stuckLoop: StuckLoopFixture = {
      id: "loop-stuck-2",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
      containerId: "arn:aws:ecs:us-east-1:123456789:task/cluster/abc123",
      s3StateKey: null,
    };

    mockFindAndUpdate([stuckLoop]);
    await GET(makeRequest());

    expect(mockStopLoopTask).toHaveBeenCalledOnce();
    expect(mockStopLoopTask).toHaveBeenCalledWith(
      stuckLoop.containerId,
      "Cron timeout safety net"
    );
  });

  it("calls scrubContextPackSecrets when the loop has an s3StateKey", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const stuckLoop: StuckLoopFixture = {
      id: "loop-stuck-3",
      organizationId: "org-1",
      status: LoopStatus.CLAIMED,
      containerId: null,
      s3StateKey: "orgs/org-1/loops/loop-stuck-3/context-pack.json",
    };

    mockFindAndUpdate([stuckLoop]);
    await GET(makeRequest());

    expect(mockScrubContextPackSecrets).toHaveBeenCalledOnce();
    expect(mockScrubContextPackSecrets).toHaveBeenCalledWith(
      stuckLoop.s3StateKey
    );
  });

  it("counts zero when updateMany returns count 0 (loop already transitioned)", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const stuckLoop: StuckLoopFixture = {
      id: "loop-stuck-4",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
      containerId: null,
      s3StateKey: null,
    };

    mockFindAndUpdate([stuckLoop], 0);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("OK: timed out 0 loops");

    // addEvent should NOT be called when the loop was not actually timed out
    expect(mockAddEvent).not.toHaveBeenCalled();
  });
});
