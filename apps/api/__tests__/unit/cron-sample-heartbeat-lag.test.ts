/**
 * T-5.3 — Unit tests for GET /api/cron/sample-heartbeat-lag
 *
 * Verifies:
 * - Auth guard (missing CRON_SECRET, wrong token, correct token)
 * - emitHeartbeatLag is called per RUNNING loop with lastRunnerHeartbeatAt set,
 *   with the correct lag value in milliseconds (now - lastRunnerHeartbeatAt).
 * - emitZombieDetector is called with the count of loops where
 *   tokenExpiresAt < now().
 * - Loops with null lastRunnerHeartbeatAt are skipped for heartbeat lag.
 * - Response body includes sampled count and zombie count.
 *
 * Follows the cron-timeout-loops.test.ts pattern for mocking auth, database,
 * and observability modules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const { mockWithDb, mockEmitHeartbeatLag, mockEmitZombieDetector } = vi.hoisted(
  () => ({
    mockWithDb: vi.fn(),
    mockEmitHeartbeatLag: vi.fn(),
    mockEmitZombieDetector: vi.fn(),
  })
);

import {
  createDatabaseMockModule,
  createLogMockModule,
} from "../fixtures/mock-modules";

vi.mock("@repo/observability/log", () => createLogMockModule());

vi.mock("@repo/database", () =>
  createDatabaseMockModule({ withDb: mockWithDb })
);

vi.mock("@/lib/observability/loop-runner-metrics", () => ({
  emitHeartbeatLag: mockEmitHeartbeatLag,
  emitZombieDetector: mockEmitZombieDetector,
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { GET } from "@/app/cron/sample-heartbeat-lag/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RunningLoopFixture = {
  id: string;
  organizationId: string;
  lastRunnerHeartbeatAt: Date | null;
  tokenExpiresAt: Date | null;
};

const ORG_ID = "org-test";

function makeRequest(token = "test-secret"): Request {
  return new Request("http://localhost/api/cron/sample-heartbeat-lag", {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
}

/**
 * Sets up mockWithDb to return the given loops and calls GET.
 */
async function callWithLoops(loops: RunningLoopFixture[]): Promise<Response> {
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      loop: {
        findMany: vi.fn().mockResolvedValue(loops),
      },
    })
  );
  return await GET(makeRequest());
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe("GET /api/cron/sample-heartbeat-lag — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CRON_SECRET;
  });

  it("returns 500 when CRON_SECRET is not set", async () => {
    process.env.CRON_SECRET = "";
    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const request = new Request(
      "http://localhost/api/cron/sample-heartbeat-lag"
    );
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("returns 401 when Authorization header has wrong token", async () => {
    const response = await GET(makeRequest("wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("returns 200 when Authorization header has correct token", async () => {
    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ loop: { findMany: vi.fn().mockResolvedValue([]) } })
    );
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat lag emission tests
// ---------------------------------------------------------------------------

describe("GET /api/cron/sample-heartbeat-lag — emitHeartbeatLag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CRON_SECRET;
  });

  it("does not call emitHeartbeatLag when there are no RUNNING loops", async () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    await callWithLoops([]);
    expect(mockEmitHeartbeatLag).not.toHaveBeenCalled();
  });

  it("does not call emitHeartbeatLag for loops with null lastRunnerHeartbeatAt", async () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const loop: RunningLoopFixture = {
      id: "loop-no-heartbeat",
      organizationId: ORG_ID,
      lastRunnerHeartbeatAt: null,
      tokenExpiresAt: null,
    };
    await callWithLoops([loop]);
    expect(mockEmitHeartbeatLag).not.toHaveBeenCalled();
  });

  it("calls emitHeartbeatLag once per loop that has lastRunnerHeartbeatAt set", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loops: RunningLoopFixture[] = [
      {
        id: "loop-1",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: new Date(now.getTime() - 10_000),
        tokenExpiresAt: null,
      },
      {
        id: "loop-2",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: new Date(now.getTime() - 20_000),
        tokenExpiresAt: null,
      },
      {
        id: "loop-3",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: null, // skipped
        tokenExpiresAt: null,
      },
    ];

    await callWithLoops(loops);

    // Only loops with non-null lastRunnerHeartbeatAt get lag samples
    expect(mockEmitHeartbeatLag).toHaveBeenCalledTimes(2);
    expect(mockEmitHeartbeatLag).toHaveBeenCalledWith(ORG_ID, "loop-1", 10_000);
    expect(mockEmitHeartbeatLag).toHaveBeenCalledWith(ORG_ID, "loop-2", 20_000);
  });

  it("includes lagSampleCount in response body", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loops: RunningLoopFixture[] = [
      {
        id: "loop-a",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: new Date(now.getTime() - 5000),
        tokenExpiresAt: null,
      },
      {
        id: "loop-b",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: new Date(now.getTime() - 15_000),
        tokenExpiresAt: null,
      },
    ];

    const response = await callWithLoops(loops);
    const text = await response.text();
    expect(text).toContain("sampled 2 heartbeat lags");
  });
});

// ---------------------------------------------------------------------------
// Zombie detector emission tests
// ---------------------------------------------------------------------------

describe("GET /api/cron/sample-heartbeat-lag — emitZombieDetector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CRON_SECRET;
  });

  it("calls emitZombieDetector with 0 when no loops have expired tokens", async () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    await callWithLoops([]);
    expect(mockEmitZombieDetector).toHaveBeenCalledOnce();
    expect(mockEmitZombieDetector).toHaveBeenCalledWith(0);
  });

  it("calls emitZombieDetector with 0 when all tokenExpiresAt are null", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loops: RunningLoopFixture[] = [
      {
        id: "loop-1",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: null,
        tokenExpiresAt: null,
      },
      {
        id: "loop-2",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: null,
        tokenExpiresAt: null,
      },
    ];

    await callWithLoops(loops);
    expect(mockEmitZombieDetector).toHaveBeenCalledOnce();
    expect(mockEmitZombieDetector).toHaveBeenCalledWith(0);
  });

  it("calls emitZombieDetector with 0 when tokenExpiresAt is in the future", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loop: RunningLoopFixture = {
      id: "loop-future-token",
      organizationId: ORG_ID,
      lastRunnerHeartbeatAt: null,
      // expires 1 hour from now — not a zombie
      tokenExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    };

    await callWithLoops([loop]);
    expect(mockEmitZombieDetector).toHaveBeenCalledOnce();
    expect(mockEmitZombieDetector).toHaveBeenCalledWith(0);
  });

  it("counts only loops with tokenExpiresAt strictly before now", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loops: RunningLoopFixture[] = [
      {
        id: "loop-expired-1",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: null,
        // 1 second before now — zombie
        tokenExpiresAt: new Date(now.getTime() - 1000),
      },
      {
        id: "loop-expired-2",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: null,
        // 1 hour before now — zombie
        tokenExpiresAt: new Date(now.getTime() - 60 * 60 * 1000),
      },
      {
        id: "loop-future",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: null,
        // 1 minute from now — not a zombie
        tokenExpiresAt: new Date(now.getTime() + 60_000),
      },
      {
        id: "loop-null-token",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: null,
        // null tokenExpiresAt — not a zombie
        tokenExpiresAt: null,
      },
    ];

    await callWithLoops(loops);
    // Only 2 loops have tokenExpiresAt < now
    expect(mockEmitZombieDetector).toHaveBeenCalledOnce();
    expect(mockEmitZombieDetector).toHaveBeenCalledWith(2);
  });

  it("includes zombieCount in response body", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loops: RunningLoopFixture[] = [
      {
        id: "loop-zombie",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: null,
        tokenExpiresAt: new Date(now.getTime() - 1000),
      },
    ];

    const response = await callWithLoops(loops);
    const text = await response.text();
    expect(text).toContain("1 zombies");
  });
});

// ---------------------------------------------------------------------------
// Combined scenario: both heartbeat lag and zombie detection in same pass
// ---------------------------------------------------------------------------

describe("GET /api/cron/sample-heartbeat-lag — combined sampling pass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CRON_SECRET;
  });

  it("emits correct lag and zombie count when loops have both fields set", async () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const loops: RunningLoopFixture[] = [
      {
        id: "loop-healthy",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: new Date(now.getTime() - 10_000),
        // valid token — not a zombie
        tokenExpiresAt: new Date(now.getTime() + 60_000),
      },
      {
        id: "loop-zombie-with-heartbeat",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: new Date(now.getTime() - 25_000),
        // expired token — zombie
        tokenExpiresAt: new Date(now.getTime() - 5000),
      },
      {
        id: "loop-no-heartbeat-zombie",
        organizationId: ORG_ID,
        lastRunnerHeartbeatAt: null,
        // expired token — zombie, but no lag sample
        tokenExpiresAt: new Date(now.getTime() - 2000),
      },
    ];

    const response = await callWithLoops(loops);

    // Two loops have lastRunnerHeartbeatAt set
    expect(mockEmitHeartbeatLag).toHaveBeenCalledTimes(2);
    expect(mockEmitHeartbeatLag).toHaveBeenCalledWith(
      ORG_ID,
      "loop-healthy",
      10_000
    );
    expect(mockEmitHeartbeatLag).toHaveBeenCalledWith(
      ORG_ID,
      "loop-zombie-with-heartbeat",
      25_000
    );

    // Two loops have tokenExpiresAt < now
    expect(mockEmitZombieDetector).toHaveBeenCalledOnce();
    expect(mockEmitZombieDetector).toHaveBeenCalledWith(2);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("OK: sampled 2 heartbeat lags, 2 zombies");
  });

  it("calls emitZombieDetector exactly once even when no loops are present", async () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    await callWithLoops([]);
    // emitZombieDetector must always be called once per cron pass
    expect(mockEmitZombieDetector).toHaveBeenCalledOnce();
    expect(mockEmitZombieDetector).toHaveBeenCalledWith(0);
  });
});
