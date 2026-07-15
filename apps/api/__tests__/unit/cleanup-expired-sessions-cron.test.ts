/**
 * Unit tests for GET /api/cron/cleanup-expired-sessions.
 *
 * Verifies the route's auth gate and the alert integration:
 * (a) exitCode: 0 (clean sweep) returns 200 and does NOT alert
 * (b) exitCode: 1 (sweep error) returns 500 and alerts notifySlack with route
 *     identifier "cleanup-expired-sessions:daily"
 * (c) Slack-never-throws — notifySlack rejecting does not prevent the 500
 * (d) a missing/invalid CRON_SECRET bearer short-circuits before the sweep
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const { mockRunRetentionSweep, mockNotifySlack, mockBuildCorrelationId } =
  vi.hoisted(() => ({
    mockRunRetentionSweep: vi.fn(),
    mockNotifySlack: vi.fn().mockResolvedValue(undefined),
    mockBuildCorrelationId: vi
      .fn()
      .mockReturnValue("ts=2026-01-01T00:00:00.000Z"),
  }));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/agent-sessions/retention-service", () => ({
  sessionRetentionService: {
    runRetentionSweep: mockRunRetentionSweep,
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

import { GET } from "@/app/cron/cleanup-expired-sessions/route";

function makeRequest(token = "test-cron-secret"): Request {
  return new Request("http://localhost/api/cron/cleanup-expired-sessions", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

const cleanResult = {
  summary: "Deleted 4 expired desktop session(s) inactive > 365d (cutoff …)",
  cutoff: "2025-06-26T00:00:00.000Z",
  retentionDays: 365,
  deleted: 4,
  exitCode: 0 as const,
};

const failedResult = {
  summary: "Session retention sweep failed: boom",
  cutoff: "2025-06-26T00:00:00.000Z",
  retentionDays: 365,
  deleted: 0,
  exitCode: 1 as const,
};

describe("GET /api/cron/cleanup-expired-sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("(a) exitCode 0 returns 200 and does not alert", async () => {
    mockRunRetentionSweep.mockResolvedValue(cleanResult);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it("(b) exitCode 1 returns 500 and alerts with the route identifier", async () => {
    mockRunRetentionSweep.mockResolvedValue(failedResult);

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ route: "cleanup-expired-sessions:daily" })
    );
  });

  it("(c) a rejecting notifySlack still yields a 500", async () => {
    mockRunRetentionSweep.mockResolvedValue(failedResult);
    mockNotifySlack.mockRejectedValueOnce(new Error("slack down"));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
  });

  it("(d) rejects an invalid CRON_SECRET before sweeping", async () => {
    const response = await GET(makeRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockRunRetentionSweep).not.toHaveBeenCalled();
  });
});
