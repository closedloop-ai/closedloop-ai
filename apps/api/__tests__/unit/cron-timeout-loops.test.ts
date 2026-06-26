/**
 * Tests for GET /api/cron/timeout-loops
 *
 * Uses vi.mock to replace withDb with a fake that captures Prisma query args.
 * Each stuck-loop test needs two mockImplementationOnce calls: one for findMany
 * and one for updateMany inside timeoutLoop(). Omitting the second causes
 * "updateMany is not a function".
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// --- Mocks (must come before imports) ---
//
// vi.hoisted() is required for ALL variables referenced inside vi.mock() factories.
// vi.mock() calls are hoisted to the top of the file before any const declarations,
// so factory closures over non-hoisted variables throw ReferenceError.

const {
  mockWithDb,
  mockWithDbTx,
  mockAddEvent,
  mockStopLoopTask,
  mockScrubContextPackSecrets,
  mockEmitReapTransition,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockAddEvent: vi.fn().mockResolvedValue(undefined),
  mockStopLoopTask: vi.fn().mockResolvedValue(undefined),
  mockScrubContextPackSecrets: vi.fn().mockResolvedValue(undefined),
  mockEmitReapTransition: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    addEvent: mockAddEvent,
    reconcileBlockedLoops: vi.fn().mockResolvedValue(0),
    reapStaleBlockedLoops: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock("@/lib/loops/loop-ecs", () => ({
  stopLoopTask: mockStopLoopTask,
}));

vi.mock("@/lib/loops/loop-state", () => ({
  scrubContextPackSecrets: mockScrubContextPackSecrets,
}));

vi.mock("@/lib/observability/loop-runner-metrics", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/observability/loop-runner-metrics")
    >();
  return {
    ...actual,
    emitReapTransition: mockEmitReapTransition,
  };
});

// withDb is called twice per stuck loop: once for findMany, once for updateMany.
// Use mockImplementationOnce so the first call provides the findMany mock
// and the second call provides the updateMany mock inside timeoutLoop().
// Failing to mock both calls causes "updateMany is not a function".
vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
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
import { GET } from "@/app/cron/timeout-loops/route";
import { ReapReason } from "@/lib/observability/loop-runner-metrics";

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
  lastRunnerHeartbeatAt: Date | null;
  runnerCapabilities: Record<string, unknown> | null;
  tokenExpiresAt: Date | null;
  startedAt: Date | null;
};

/** Build a StuckLoopFixture with sensible defaults for the new heartbeat fields. */
function makeStuckLoop(
  overrides: Partial<StuckLoopFixture> &
    Pick<StuckLoopFixture, "id" | "organizationId" | "status">
): StuckLoopFixture {
  return {
    containerId: null,
    s3StateKey: null,
    computeTargetId: null,
    lastRunnerHeartbeatAt: null,
    runnerCapabilities: null,
    tokenExpiresAt: null,
    startedAt: null,
    ...overrides,
  };
}

type TxHandles = {
  updateMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  loopEventCreate: ReturnType<typeof vi.fn>;
};

/**
 * Mocks the withDb findMany call and the withDb.tx transaction call needed for
 * a single stuck loop. Returns handles for every db method invoked inside the
 * transaction so callers can assert on cleanup behavior directly. The CAS and
 * the token-clear inside clearLoopTokens both call `loop.updateMany`.
 */
function mockFindAndUpdate(
  loops: StuckLoopFixture[],
  updateCount = 1
): TxHandles {
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      loop: {
        findMany: vi.fn().mockResolvedValue(loops),
      },
    })
  );

  const handles: TxHandles = {
    updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
    deleteMany: vi.fn().mockResolvedValue({ count: updateCount }),
    loopEventCreate: vi.fn().mockResolvedValue({}),
  };

  mockWithDbTx.mockImplementationOnce((fn: (db: unknown) => Promise<unknown>) =>
    fn({
      loop: { updateMany: handles.updateMany },
      loopTokenRefresh: { deleteMany: handles.deleteMany },
      loopEvent: { create: handles.loopEventCreate },
    })
  );

  return handles;
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

  it("ECS RUNNING clause uses activity-based detection and excludes manual loops", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const activityCutoff = new Date(now.getTime() - 75 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[0]).toEqual({
      status: LoopStatus.RUNNING,
      computeTargetId: null,
      command: { not: LoopCommand.Manual },
      events: { none: { createdAt: { gte: activityCutoff } } },
    });
  });

  it("manual RUNNING clause uses 7-day inactivity window", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const manualRunningCutoff = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000
    );
    const args = await captureWhereClause(now);

    expect(args.where.OR[1]).toEqual({
      status: LoopStatus.RUNNING,
      command: LoopCommand.Manual,
      createdAt: { lt: manualRunningCutoff },
      events: { none: { createdAt: { gte: manualRunningCutoff } } },
    });
  });

  it("desktop RUNNING (heartbeat-eligible) clause uses dual predicate with 2h stale threshold", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const heartbeatStaleCutoff = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[2]).toEqual({
      status: LoopStatus.RUNNING,
      computeTargetId: { not: null },
      OR: [
        {
          lastRunnerHeartbeatAt: { not: null, lt: heartbeatStaleCutoff },
        },
        {
          lastRunnerHeartbeatAt: null,
          runnerCapabilities: {
            path: ["loopRunnerHeartbeatSupported"],
            equals: true,
          },
          startedAt: { not: null, lt: heartbeatStaleCutoff },
        },
      ],
    });
  });

  it("desktop RUNNING (legacy safety net) clause uses 24h createdAt cutoff for loops with no heartbeat ever", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const desktopRunningCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[3]).toEqual({
      status: LoopStatus.RUNNING,
      computeTargetId: { not: null },
      lastRunnerHeartbeatAt: null,
      createdAt: { lt: desktopRunningCutoff },
    });
  });

  it("CLAIMED clause reaps both ECS and desktop (no computeTargetId filter)", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const claimedCutoff = new Date(now.getTime() - 90 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[4]).toEqual({
      status: LoopStatus.CLAIMED,
      createdAt: { lt: claimedCutoff },
    });
  });

  it("PENDING clause reaps both ECS and desktop (no computeTargetId filter)", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const pendingCutoff = new Date(now.getTime() - 30 * 60 * 1000);
    const args = await captureWhereClause(now);

    expect(args.where.OR[5]).toEqual({
      status: LoopStatus.PENDING,
      createdAt: { lt: pendingCutoff },
    });
  });

  it("select clause includes computeTargetId and heartbeat fields", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const args = await captureWhereClause(now);

    expect(args.select).toHaveProperty("computeTargetId", true);
    expect(args.select).toHaveProperty("lastRunnerHeartbeatAt", true);
    expect(args.select).toHaveProperty("runnerCapabilities", true);
    expect(args.select).toHaveProperty("tokenExpiresAt", true);
    expect(args.select).toHaveProperty("startedAt", true);
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

    const stuckLoop = makeStuckLoop({
      id: "loop-stuck-1",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
    });

    const { updateMany: mockUpdateMany } = mockFindAndUpdate([stuckLoop]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("OK: timed out 1 loops");

    // updateMany is called twice: once for the CAS, once for the token-clear
    // inside clearLoopTokens.
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
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

    const stuckLoop = makeStuckLoop({
      id: "loop-stuck-2",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
      containerId: "arn:aws:ecs:us-east-1:123456789:task/cluster/abc123",
    });

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

    const stuckLoop = makeStuckLoop({
      id: "loop-stuck-3",
      organizationId: "org-1",
      status: LoopStatus.CLAIMED,
      s3StateKey: "orgs/org-1/loops/loop-stuck-3/context-pack.json",
    });

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

    const stuckLoop = makeStuckLoop({
      id: "loop-stuck-4",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
    });

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

    const desktopLoop = makeStuckLoop({
      id: "loop-desktop-1",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
      containerId: "cmd-123",
      computeTargetId: "ct-abc",
    });

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

    const ecsLoop = makeStuckLoop({
      id: "loop-ecs-1",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
      containerId: "arn:aws:ecs:us-east-1:123456789:task/cluster/xyz",
    });

    mockFindAndUpdate([ecsLoop]);
    await GET(makeRequest());

    expect(mockStopLoopTask).toHaveBeenCalledOnce();
    expect(mockStopLoopTask).toHaveBeenCalledWith(
      ecsLoop.containerId,
      "Cron timeout safety net"
    );
  });

  // Scenario 8: token clearing inside a single withDb.tx transaction
  it("clears tokens and creates loopEvent inside withDb.tx when updateMany succeeds", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const staleLoop = makeStuckLoop({
      id: "loop-stale-8",
      organizationId: "org-8",
      status: LoopStatus.RUNNING,
    });

    const { updateMany, deleteMany, loopEventCreate } = mockFindAndUpdate([
      staleLoop,
    ]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK: timed out 1 loops");

    expect(mockWithDbTx).toHaveBeenCalledOnce();

    // updateMany is called twice: once for the CAS, once inside clearLoopTokens
    // to null out activeTokenJti/tokenExpiresAt (uses updateMany so the where
    // clause can include organizationId).
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: staleLoop.id,
          organizationId: staleLoop.organizationId,
        }),
        data: expect.objectContaining({ status: LoopStatus.TIMED_OUT }),
      })
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: staleLoop.id, organizationId: staleLoop.organizationId },
      data: { activeTokenJti: null, tokenExpiresAt: null },
    });

    expect(deleteMany).toHaveBeenCalledOnce();
    expect(deleteMany).toHaveBeenCalledWith({
      where: { loopId: staleLoop.id },
    });

    expect(loopEventCreate).toHaveBeenCalledOnce();
    expect(loopEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loopId: staleLoop.id,
          type: "tokens_cleared",
          eventSource: "system",
        }),
      })
    );
  });

  it("does NOT call deleteMany or loopEvent.create inside withDb.tx when updateMany returns count 0", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const staleLoop = makeStuckLoop({
      id: "loop-stale-8b",
      organizationId: "org-8",
      status: LoopStatus.RUNNING,
    });

    const { updateMany, deleteMany, loopEventCreate } = mockFindAndUpdate(
      [staleLoop],
      0
    );

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK: timed out 0 loops");

    expect(mockWithDbTx).toHaveBeenCalledOnce();
    // Only the CAS updateMany runs; the token-clear updateMany inside
    // clearLoopTokens is gated by `cas.count > 0`.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(loopEventCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Heartbeat-driven reaper tests (PLN-638)
// ---------------------------------------------------------------------------

describe("GET /api/cron/timeout-loops — heartbeat reaper branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.CRON_SECRET = undefined;
  });

  // T-3.3: CLAIMED Desktop loop with stale heartbeat is NOT matched by
  // heartbeat branch (status=RUNNING requirement excludes CLAIMED)
  it("heartbeat branch requires status=RUNNING — CLAIMED loops use the CLAIMED branch", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const args = await captureWhereClause(now);

    // Heartbeat-eligible clause (OR[2]) has status: RUNNING
    expect(args.where.OR[2]).toHaveProperty("status", LoopStatus.RUNNING);
    // Legacy desktop clause (OR[3]) also has status: RUNNING
    expect(args.where.OR[3]).toHaveProperty("status", LoopStatus.RUNNING);
    // CLAIMED clause (OR[4]) has status: CLAIMED — no computeTargetId/heartbeat filter
    const claimedCutoff = new Date(now.getTime() - 90 * 60 * 1000);
    expect(args.where.OR[4]).toEqual({
      status: LoopStatus.CLAIMED,
      createdAt: { lt: claimedCutoff },
    });
  });

  // T-3.6: Desktop loop with only loopRunnerRefreshSupported=true is NOT
  // eligible for heartbeat branch
  it("desktop loop with only loopRunnerRefreshSupported=true falls to legacy branch", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    // Loop with refresh capability but NOT heartbeat capability,
    // lastRunnerHeartbeatAt=null, created 25h ago → should be reaped by
    // the legacy 24h branch (OR[3]) with reason=desktop_legacy_24h.
    const loop = makeStuckLoop({
      id: "loop-refresh-only",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
      computeTargetId: "ct-refresh",
      lastRunnerHeartbeatAt: null,
      runnerCapabilities: { loopRunnerRefreshSupported: true },
      tokenExpiresAt: new Date(now.getTime() + 60_000),
    });

    const { updateMany } = mockFindAndUpdate([loop]);
    await GET(makeRequest());

    expect(updateMany).toHaveBeenCalled();
    // The reaper reason should be desktop_legacy_24h, not any heartbeat reason
    expect(mockEmitReapTransition).toHaveBeenCalledWith(
      loop.id,
      ReapReason.DesktopLegacy24h
    );
  });

  // T-3.7: Reaper payload structure in addEvent call
  it("addEvent carries reaper payload with reason, lastHeartbeatAt, tokenExpiresAt, and eligibilityBranch", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const lastHeartbeat = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3h ago
    const tokenExpiry = new Date(now.getTime() + 30 * 60 * 1000); // 30min future

    const loop = makeStuckLoop({
      id: "loop-heartbeat-stale",
      organizationId: "org-hb",
      status: LoopStatus.RUNNING,
      computeTargetId: "ct-hb-1",
      lastRunnerHeartbeatAt: lastHeartbeat,
      runnerCapabilities: { loopRunnerHeartbeatSupported: true },
      tokenExpiresAt: tokenExpiry,
      startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
    });

    mockFindAndUpdate([loop]);
    await GET(makeRequest());

    expect(mockAddEvent).toHaveBeenCalledOnce();
    const eventArg = mockAddEvent.mock.calls[0][2];
    expect(eventArg.type).toBe("error");
    expect(eventArg.data).toEqual(
      expect.objectContaining({
        code: "TIMED_OUT",
        reaper: {
          reason: ReapReason.DesktopHeartbeatStale,
          lastHeartbeatAt: lastHeartbeat.toISOString(),
          tokenExpiresAt: tokenExpiry.toISOString(),
          eligibilityBranch: "desktop_heartbeat",
        },
      })
    );
  });

  // T-3.8: emitReapTransition called with correct reason per reaper branch
  it("emitReapTransition is called with desktop_heartbeat_stale for stale heartbeat loop", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loop = makeStuckLoop({
      id: "loop-hb-stale-metric",
      organizationId: "org-m1",
      status: LoopStatus.RUNNING,
      computeTargetId: "ct-m1",
      lastRunnerHeartbeatAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
      runnerCapabilities: { loopRunnerHeartbeatSupported: true },
      startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
    });

    mockFindAndUpdate([loop]);
    await GET(makeRequest());

    expect(mockEmitReapTransition).toHaveBeenCalledWith(
      loop.id,
      ReapReason.DesktopHeartbeatStale
    );
  });

  it("emitReapTransition is called with desktop_no_heartbeat for capability-advertised loop with null heartbeat", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loop = makeStuckLoop({
      id: "loop-no-hb-metric",
      organizationId: "org-m2",
      status: LoopStatus.RUNNING,
      computeTargetId: "ct-m2",
      lastRunnerHeartbeatAt: null,
      runnerCapabilities: { loopRunnerHeartbeatSupported: true },
      startedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
    });

    mockFindAndUpdate([loop]);
    await GET(makeRequest());

    expect(mockEmitReapTransition).toHaveBeenCalledWith(
      loop.id,
      ReapReason.DesktopNoHeartbeat
    );
  });

  it("emitReapTransition is called with desktop_legacy_24h for legacy desktop loop", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loop = makeStuckLoop({
      id: "loop-legacy-metric",
      organizationId: "org-m3",
      status: LoopStatus.RUNNING,
      computeTargetId: "ct-m3",
      lastRunnerHeartbeatAt: null,
      runnerCapabilities: null,
      tokenExpiresAt: new Date(now.getTime() - 60_000),
    });

    mockFindAndUpdate([loop]);
    await GET(makeRequest());

    expect(mockEmitReapTransition).toHaveBeenCalledWith(
      loop.id,
      ReapReason.DesktopLegacy24h
    );
  });

  // Verify non-Desktop loops do NOT emit reap transition metrics
  it("emitReapTransition is NOT called for ECS RUNNING loops", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const ecsLoop = makeStuckLoop({
      id: "loop-ecs-no-metric",
      organizationId: "org-ecs",
      status: LoopStatus.RUNNING,
    });

    mockFindAndUpdate([ecsLoop]);
    await GET(makeRequest());

    expect(mockEmitReapTransition).not.toHaveBeenCalled();
  });

  it("emitReapTransition is NOT called for PENDING loops", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const pendingLoop = makeStuckLoop({
      id: "loop-pending-no-metric",
      organizationId: "org-pending",
      status: LoopStatus.PENDING,
    });

    mockFindAndUpdate([pendingLoop]);
    await GET(makeRequest());

    expect(mockEmitReapTransition).not.toHaveBeenCalled();
  });

  // OR[3]-only misclassification regression: capability flag advertised,
  // no heartbeat ever received, startedAt is NULL, createdAt > 24h ago.
  // The DB matches this via OR[3] (legacy), so the runtime classifier must
  // also classify it as legacy — not as the heartbeat branch.
  it("classifies OR[3]-only loop (capability flag, startedAt=null) as DesktopLegacy24h", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loop = makeStuckLoop({
      id: "loop-or3-null-startedAt",
      organizationId: "org-or3a",
      status: LoopStatus.RUNNING,
      computeTargetId: "ct-or3a",
      lastRunnerHeartbeatAt: null,
      runnerCapabilities: { loopRunnerHeartbeatSupported: true },
      startedAt: null,
    });

    mockFindAndUpdate([loop]);
    await GET(makeRequest());

    expect(mockEmitReapTransition).toHaveBeenCalledWith(
      loop.id,
      ReapReason.DesktopLegacy24h
    );
    const eventArg = mockAddEvent.mock.calls[0][2];
    expect(eventArg.data.reaper.eligibilityBranch).toBe("desktop_legacy");
  });

  // Sibling case: capability flag advertised, startedAt is set but FRESHER
  // than the heartbeat stale cutoff (so DB OR[2] would not match). DB matches
  // via OR[3] only — runtime must also classify as legacy.
  it("classifies capability-flagged loop with fresh startedAt as DesktopLegacy24h", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    // startedAt = 1h ago, heartbeat stale cutoff = 2h ago.
    // startedAt (1h ago) is NOT older than cutoff (2h ago), so the
    // heartbeat sub-clause in OR[2] does not match.
    const loop = makeStuckLoop({
      id: "loop-or3-fresh-startedAt",
      organizationId: "org-or3b",
      status: LoopStatus.RUNNING,
      computeTargetId: "ct-or3b",
      lastRunnerHeartbeatAt: null,
      runnerCapabilities: { loopRunnerHeartbeatSupported: true },
      startedAt: new Date(now.getTime() - 60 * 60 * 1000),
    });

    mockFindAndUpdate([loop]);
    await GET(makeRequest());

    expect(mockEmitReapTransition).toHaveBeenCalledWith(
      loop.id,
      ReapReason.DesktopLegacy24h
    );
    const eventArg = mockAddEvent.mock.calls[0][2];
    expect(eventArg.data.reaper.eligibilityBranch).toBe("desktop_legacy");
  });

  // Malformed runnerCapabilities (JSON primitive instead of object): Zod
  // safeParse fails, capabilities treated as null, loop classifies as legacy.
  it("classifies loop with malformed runnerCapabilities as DesktopLegacy24h", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loop = makeStuckLoop({
      id: "loop-malformed-caps",
      organizationId: "org-malformed",
      status: LoopStatus.RUNNING,
      computeTargetId: "ct-malformed",
      lastRunnerHeartbeatAt: null,
      // Primitive in a JsonValue column — would have produced undefined
      // reads under the previous `as` cast.
      runnerCapabilities: 42 as unknown as Record<string, unknown>,
      startedAt: null,
    });

    mockFindAndUpdate([loop]);
    await GET(makeRequest());

    expect(mockEmitReapTransition).toHaveBeenCalledWith(
      loop.id,
      ReapReason.DesktopLegacy24h
    );
    const eventArg = mockAddEvent.mock.calls[0][2];
    expect(eventArg.data.reaper.eligibilityBranch).toBe("desktop_legacy");
  });

  // Verify addEvent does NOT include reaper payload for non-Desktop loops
  it("addEvent does NOT include reaper payload for ECS loops", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const ecsLoop = makeStuckLoop({
      id: "loop-ecs-no-reaper",
      organizationId: "org-ecs2",
      status: LoopStatus.RUNNING,
    });

    mockFindAndUpdate([ecsLoop]);
    await GET(makeRequest());

    expect(mockAddEvent).toHaveBeenCalledOnce();
    const eventArg = mockAddEvent.mock.calls[0][2];
    expect(eventArg.data).not.toHaveProperty("reaper");
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
      documentId: artifactId,
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
      documentId: artifactId,
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

  it("continues stuck-loop processing when warnGhostLoopAnomalies throws", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const stuckLoop = makeStuckLoop({
      id: "loop-stuck-after-anomaly-error",
      organizationId: "org-1",
      status: LoopStatus.RUNNING,
    });

    // First withDb call: stuckLoops findMany — returns a stuck loop
    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          findMany: vi.fn().mockResolvedValue([stuckLoop]),
        },
      })
    );

    // Second withDb call: anomaly detection — throws a DB error
    mockWithDb.mockImplementationOnce(() => {
      throw new Error("DB connection lost");
    });

    // withDb.tx call: transaction inside timeoutLoop — should still execute
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockWithDbTx.mockImplementationOnce(
      (fn: (db: unknown) => Promise<unknown>) =>
        fn({
          loop: {
            update: vi.fn().mockResolvedValue({}),
            updateMany: mockUpdateMany,
          },
          loopTokenRefresh: {
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          loopEvent: {
            create: vi.fn().mockResolvedValue({}),
          },
        })
    );

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("OK: timed out 1 loops");

    // Verify the stuck loop was still processed despite anomaly detection
    // failure. updateMany is called twice: once for the CAS, once inside
    // clearLoopTokens (which uses updateMany so the where clause can include
    // organizationId).
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockAddEvent).toHaveBeenCalledOnce();

    // Verify the error was logged
    const errorCalls = (log.error as Mock).mock.calls;
    const anomalyErrorCall = errorCalls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("Ghost loop anomaly check failed")
    );
    expect(anomalyErrorCall).toBeDefined();
    expect(anomalyErrorCall?.[1]).toEqual({
      error: "DB connection lost",
    });
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
