/**
 * FEA-3286: unit tests for GET /api/cron/cleanup-phantom-sessions.
 *
 * Verifies the route's auth gate and the alert integration:
 * (a) exitCode: 0 (clean sweep) returns 200, logs swept ids, and does NOT alert
 * (b) exitCode: 1 (sweep error) returns 500 and alerts notifySlack with route
 *     identifier "cleanup-phantom-sessions:daily"
 * (c) Slack-never-throws — notifySlack rejecting does not prevent the 500
 * (d) a missing/invalid CRON_SECRET bearer short-circuits before the sweep
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const {
  mockRunPhantomSweep,
  mockNotifySlack,
  mockBuildCorrelationId,
  mockLogInfo,
} = vi.hoisted(() => ({
  mockRunPhantomSweep: vi.fn(),
  mockNotifySlack: vi.fn(async () => undefined),
  mockBuildCorrelationId: vi.fn(() => "ts=2026-01-01T00:00:00.000Z"),
  mockLogInfo: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

vi.mock("@/app/agent-sessions/phantom-retention-service", () => ({
  phantomRetentionService: {
    runPhantomSweep: mockRunPhantomSweep,
  },
}));

vi.mock("@/lib/slack-notifier", () => ({
  notifySlack: mockNotifySlack,
  buildCorrelationId: mockBuildCorrelationId,
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
  scheduleLogFlushAfter: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { GET } from "@/app/cron/cleanup-phantom-sessions/route";

function makeRequest(token = "test-cron-secret"): Request {
  return new Request("http://localhost/api/cron/cleanup-phantom-sessions", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

const cleanResult = {
  summary: "Deleted 7 phantom desktop session(s) idle > 24h (cutoff …)",
  cutoff: "2026-06-25T00:00:00.000Z",
  retentionDays: 1,
  deleted: 7,
  spared: 2,
  deletedSessionIds: ["session-1", "session-2"],
  deletedSessionIdsComplete: true,
  exitCode: 0 as const,
};

const failedResult = {
  summary: "Phantom session sweep failed: boom",
  cutoff: "2026-06-25T00:00:00.000Z",
  retentionDays: 1,
  deleted: 0,
  spared: 0,
  deletedSessionIds: [],
  deletedSessionIdsComplete: true,
  exitCode: 1 as const,
};

describe("GET /api/cron/cleanup-phantom-sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("(a) exitCode 0 returns 200 and does not alert", async () => {
    mockRunPhantomSweep.mockResolvedValue(cleanResult);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockNotifySlack).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        deleted: 7,
        // ISS-10171: the operator-facing shortfall counter is pinned here, so
        // dropping the route's `spared` field reddens this case.
        spared: 2,
        deletedSessionIds: ["session-1", "session-2"],
        deletedSessionIdsComplete: true,
      })
    );
  });

  it("(b) exitCode 1 returns 500 and alerts with the route identifier", async () => {
    mockRunPhantomSweep.mockResolvedValue(failedResult);

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ route: "cleanup-phantom-sessions:daily" })
    );
  });

  it("(c) a rejecting notifySlack still yields a 500", async () => {
    mockRunPhantomSweep.mockResolvedValue(failedResult);
    mockNotifySlack.mockRejectedValueOnce(new Error("slack down"));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
  });

  it("(d) rejects an invalid CRON_SECRET before sweeping", async () => {
    const response = await GET(makeRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockRunPhantomSweep).not.toHaveBeenCalled();
  });
});
