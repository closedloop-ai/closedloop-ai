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

import { LoopCommand } from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/database";
import { log } from "@repo/observability/log";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/cron/timeout-loops/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FindManyArgs = {
  where: { OR: Record<string, unknown>[] };
  select: Record<string, boolean>;
};

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
  computeTargetId: string | null;
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

  it("ECS RUNNING clause uses activity-based detection with computeTargetId: null", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const activityCutoff = new Date(now.getTime() - 75 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[0]).toEqual({
      status: LoopStatus.RUNNING,
      computeTargetId: null,
      events: { none: { createdAt: { gte: activityCutoff } } },
    });
  });

  it("desktop RUNNING clause uses 24h createdAt cutoff with computeTargetId not null", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const desktopRunningCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[1]).toEqual({
      status: LoopStatus.RUNNING,
      computeTargetId: { not: null },
      createdAt: { lt: desktopRunningCutoff },
    });
  });

  it("CLAIMED clause reaps both ECS and desktop (no computeTargetId filter)", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const claimedCutoff = new Date(now.getTime() - 90 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[2]).toEqual({
      status: LoopStatus.CLAIMED,
      createdAt: { lt: claimedCutoff },
    });
  });

  it("PENDING clause reaps both ECS and desktop (no computeTargetId filter)", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const pendingCutoff = new Date(now.getTime() - 30 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[3]).toEqual({
      status: LoopStatus.PENDING,
      createdAt: { lt: pendingCutoff },
    });
  });

  it("select clause includes computeTargetId", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const args = await captureWhereClause(now);

    expect(args.select).toHaveProperty("computeTargetId", true);
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
      computeTargetId: null,
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
      computeTargetId: null,
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
      computeTargetId: null,
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
      computeTargetId: null,
    };

    mockFindAndUpdate([stuckLoop], 0);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("OK: timed out 0 loops");

    // addEvent should NOT be called when the loop was not actually timed out
    expect(mockAddEvent).not.toHaveBeenCalled();
  });

  it("does NOT call stopLoopTask for desktop loops (command ID in containerId)", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const desktopLoop: StuckLoopFixture = {
      id: "loop-desktop-1",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
      containerId: "cmd-123",
      s3StateKey: null,
      computeTargetId: "ct-abc",
    };

    mockFindAndUpdate([desktopLoop]);
    await GET(makeRequest());

    // Desktop loops must NOT have their command ID passed to ECS stop
    expect(mockStopLoopTask).not.toHaveBeenCalled();
    // But they should still be marked TIMED_OUT
    expect(mockAddEvent).toHaveBeenCalledOnce();
  });

  it("calls stopLoopTask for ECS loops (computeTargetId is null)", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const ecsLoop: StuckLoopFixture = {
      id: "loop-ecs-1",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
      containerId: "arn:aws:ecs:us-east-1:123456789:task/cluster/xyz",
      s3StateKey: null,
      computeTargetId: null,
    };

    mockFindAndUpdate([ecsLoop]);
    await GET(makeRequest());

    expect(mockStopLoopTask).toHaveBeenCalledOnce();
    expect(mockStopLoopTask).toHaveBeenCalledWith(
      ecsLoop.containerId,
      "Cron timeout safety net"
    );
  });
});

// ---------------------------------------------------------------------------
// Anomaly detection helpers
// ---------------------------------------------------------------------------

type AnomalyCandidateFixture = {
  id: string;
  organizationId: string;
  computeTargetId: string | null;
  artifactId: string | null;
  command: string;
  tokensInput: number;
  tokensOutput: number;
  startedAt: Date | null;
};

/**
 * Mocks both withDb calls needed for anomaly detection tests:
 * 1. First call: stuckLoops findMany (returns empty array — not what we're testing)
 * 2. Second call: anomalyCandidates findMany (returns the given candidates)
 */
function mockEmptyStuckLoopsThenAnomalyCandidates(
  candidates: AnomalyCandidateFixture[]
): void {
  // First withDb call: stuckLoops findMany — return empty so route doesn't process timeouts
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      loop: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    })
  );

  // Second withDb call: anomalyCandidates findMany
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      loop: {
        findMany: vi.fn().mockResolvedValue(candidates),
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/cron/timeout-loops -- anomaly detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.CRON_SECRET = "test-secret";
    process.env.ENABLE_GHOST_LOOP_ANOMALY_WARNING = "true";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.CRON_SECRET = undefined;
    process.env.ENABLE_GHOST_LOOP_ANOMALY_WARNING = undefined;
  });

  it("logs warn for EXECUTE loop startedAt exactly 5 min ago with zero tokens", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    // startedAt must be strictly before the anomalyCutoff (now - 5*60*1000).
    // Use 5 min + 1ms to cross the strict "<" threshold while keeping duration
    // clearly in the "exactly 5 min" range the task describes.
    const durationMs = 5 * 60 * 1000 + 1; // 300001 ms — just past the 5 min threshold
    const startedAt = new Date(now.getTime() - durationMs);
    const loopId = "loop-ghost-1";
    const computeTargetId = "ct-ghost-1";
    const artifactId = "artifact-ghost-1";

    const candidate: AnomalyCandidateFixture = {
      id: loopId,
      organizationId: "org-1",
      computeTargetId,
      artifactId,
      command: LoopCommand.Execute,
      tokensInput: 0,
      tokensOutput: 0,
      startedAt,
    };

    mockEmptyStuckLoopsThenAnomalyCandidates([candidate]);
    await GET(makeRequest());

    const warnCalls = (log.warn as Mock).mock.calls;
    const ghostWarnCall = warnCalls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("Ghost loop anomaly")
    );
    expect(ghostWarnCall).toBeDefined();
    expect(ghostWarnCall?.[1]).toEqual({
      loopId,
      computeTargetId,
      durationMs,
      artifactId,
    });
  });

  it("does NOT log warn when startedAt is 4m59s ago (below 5 min threshold)", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    // 4 min 59 sec ago — just inside the cutoff, should not trigger
    const startedAt = new Date(now.getTime() - (5 * 60 * 1000 - 1));

    const candidate: AnomalyCandidateFixture = {
      id: "loop-ghost-2",
      organizationId: "org-1",
      computeTargetId: "ct-1",
      artifactId: "artifact-1",
      command: LoopCommand.Execute,
      tokensInput: 0,
      tokensOutput: 0,
      startedAt,
    };

    mockEmptyStuckLoopsThenAnomalyCandidates([candidate]);
    await GET(makeRequest());

    const warnCalls = (log.warn as Mock).mock.calls;
    const ghostWarnCall = warnCalls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("Ghost loop anomaly")
    );
    expect(ghostWarnCall).toBeUndefined();
  });

  it("logs warn for EXECUTE loop startedAt 10 min ago with zero tokens", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const startedAt = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago
    const loopId = "loop-ghost-3";
    const computeTargetId = "ct-ghost-3";
    const artifactId = "artifact-ghost-3";

    const candidate: AnomalyCandidateFixture = {
      id: loopId,
      organizationId: "org-1",
      computeTargetId,
      artifactId,
      command: LoopCommand.Execute,
      tokensInput: 0,
      tokensOutput: 0,
      startedAt,
    };

    mockEmptyStuckLoopsThenAnomalyCandidates([candidate]);
    await GET(makeRequest());

    const warnCalls = (log.warn as Mock).mock.calls;
    const ghostWarnCall = warnCalls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("Ghost loop anomaly")
    );
    expect(ghostWarnCall).toBeDefined();
    expect(ghostWarnCall?.[1]).toEqual({
      loopId,
      computeTargetId,
      durationMs: 600_000,
      artifactId,
    });
  });

  it("does NOT log warn when tokensInput is non-zero", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const startedAt = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago

    const candidate: AnomalyCandidateFixture = {
      id: "loop-ghost-4",
      organizationId: "org-1",
      computeTargetId: "ct-1",
      artifactId: "artifact-1",
      command: LoopCommand.Execute,
      tokensInput: 100, // non-zero — has consumed tokens, not a ghost
      tokensOutput: 0,
      startedAt,
    };

    mockEmptyStuckLoopsThenAnomalyCandidates([candidate]);
    await GET(makeRequest());

    const warnCalls = (log.warn as Mock).mock.calls;
    const ghostWarnCall = warnCalls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("Ghost loop anomaly")
    );
    expect(ghostWarnCall).toBeUndefined();
  });

  it("does NOT log warn for PLAN loop with zero tokens and startedAt >5 min ago", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const startedAt = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago

    const candidate: AnomalyCandidateFixture = {
      id: "loop-ghost-5",
      organizationId: "org-1",
      computeTargetId: "ct-1",
      artifactId: "artifact-1",
      command: LoopCommand.Plan, // PLAN, not EXECUTE — should not trigger
      tokensInput: 0,
      tokensOutput: 0,
      startedAt,
    };

    mockEmptyStuckLoopsThenAnomalyCandidates([candidate]);
    await GET(makeRequest());

    const warnCalls = (log.warn as Mock).mock.calls;
    const ghostWarnCall = warnCalls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("Ghost loop anomaly")
    );
    expect(ghostWarnCall).toBeUndefined();
  });

  it("calls mockWithDb only once when ENABLE_GHOST_LOOP_ANOMALY_WARNING is not set", async () => {
    process.env.ENABLE_GHOST_LOOP_ANOMALY_WARNING = undefined;

    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    // Only mock the stuckLoops findMany call — if anomaly detection runs,
    // it would call withDb a second time which would throw (no mock provided).
    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      })
    );

    await GET(makeRequest());

    // Exactly one withDb call: the stuckLoops findMany
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });
});
