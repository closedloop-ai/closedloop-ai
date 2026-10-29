/**
 * ISS-8602: unit tests for GET /api/cron/sweep-orphaned-chunk-markers.
 *
 * Verifies the route's auth gate and the alert integration:
 * (a) exitCode: 0 (clean sweep) returns 200, logs the repair count, no alert
 * (b) exitCode: 1 (sweep error) returns 500 and alerts notifySlack with route
 *     identifier "sweep-orphaned-chunk-markers:daily"
 * (c) Slack-never-throws — notifySlack rejecting does not prevent the 500
 * (d) a missing/invalid CRON_SECRET bearer short-circuits before the sweep
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const {
  mockRunPendingChunkSweep,
  mockNotifySlack,
  mockBuildCorrelationId,
  mockLogInfo,
} = vi.hoisted(() => ({
  mockRunPendingChunkSweep: vi.fn(),
  mockNotifySlack: vi.fn().mockResolvedValue(undefined),
  mockBuildCorrelationId: vi
    .fn()
    .mockReturnValue("ts=2026-01-01T00:00:00.000Z"),
  mockLogInfo: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/agent-sessions/pending-chunk-sweep-service", () => ({
  pendingChunkSweepService: {
    runPendingChunkSweep: mockRunPendingChunkSweep,
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

import { GET } from "@/app/cron/sweep-orphaned-chunk-markers/route";

const CRON_SECRET = "test-cron-secret";
const ROUTE_ALERT_ID = "sweep-orphaned-chunk-markers:daily";

function makeRequest(token = CRON_SECRET): Request {
  return new Request("http://localhost/api/cron/sweep-orphaned-chunk-markers", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

const cleanResult = {
  summary: "Cleared 3 orphaned pending-chunk marker(s) idle > 72h",
  cutoff: "2026-07-07T12:00:00.000Z",
  ttlHours: 72,
  cleared: 3,
  // ISS-8602: non-zero, so a route that drops the field fails the case below
  // rather than passing on a fixture that never carried one.
  skippedUnconfirmedAck: 4,
  exitCode: 0 as const,
};

const failedResult = {
  ...cleanResult,
  summary: "Pending chunk marker sweep failed after clearing 1 marker(s): boom",
  cleared: 1,
  exitCode: 1 as const,
};

describe("the declined-marker count", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    mockRunPendingChunkSweep.mockReset().mockResolvedValue(cleanResult);
    mockNotifySlack.mockReset().mockResolvedValue(undefined);
    mockLogInfo.mockReset();
  });

  it("reaches the route's log line beside the repair count", async () => {
    await GET(makeRequest());

    // ISS-8602 (review: review-soul + api-architect). The sibling metric is a
    // differently-named structured log with no Datadog generator in this repo, so
    // this daily line is the only channel an operator actually reads. Dropping
    // the field here makes "nothing to repair" and "plenty, none of it safe to
    // touch" the same log entry.
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cleared: 3, skippedUnconfirmedAck: 4 })
    );
  });

  it("carries an unmeasured count through as null, not zero", async () => {
    mockRunPendingChunkSweep.mockResolvedValue({
      ...cleanResult,
      skippedUnconfirmedAck: null,
    });

    await GET(makeRequest());

    // `null` is "the count never ran", which the route must forward verbatim: a
    // 0 here would assert the fleet holds nothing back on exactly the runs that
    // did not look.
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skippedUnconfirmedAck: null })
    );
  });
});

describe("GET /api/cron/sweep-orphaned-chunk-markers", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    mockRunPendingChunkSweep.mockReset().mockResolvedValue(cleanResult);
    mockNotifySlack.mockReset().mockResolvedValue(undefined);
    mockLogInfo.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 and logs the repair count on a clean sweep", async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(cleanResult.summary);
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining(cleanResult.summary),
      expect.objectContaining({ cleared: 3, ttlHours: 72 })
    );
    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it("returns 500 and alerts when the sweep errors", async () => {
    mockRunPendingChunkSweep.mockResolvedValue(failedResult);

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        route: ROUTE_ALERT_ID,
        message: failedResult.summary,
      })
    );
  });

  it("still returns 500 when the Slack alert itself rejects", async () => {
    mockRunPendingChunkSweep.mockResolvedValue(failedResult);
    mockNotifySlack.mockRejectedValue(new Error("slack down"));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
  });

  it("refuses an invalid bearer before running the sweep", async () => {
    const response = await GET(makeRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockRunPendingChunkSweep).not.toHaveBeenCalled();
  });
});
