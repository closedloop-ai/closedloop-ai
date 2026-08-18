import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRunStaleSessionSweep, mockNotifySlack, mockBuildCorrelationId } =
  vi.hoisted(() => ({
    mockRunStaleSessionSweep: vi.fn(),
    mockNotifySlack: vi.fn().mockResolvedValue(undefined),
    mockBuildCorrelationId: vi
      .fn()
      .mockReturnValue("ts=2026-07-24T18:00:00.000Z"),
  }));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/agent-sessions/stale-session-reaper-service", () => ({
  staleSessionReaperService: {
    runStaleSessionSweep: mockRunStaleSessionSweep,
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

import { GET } from "@/app/cron/reconcile-stale-sessions/route";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const CRON_SECRET = "test-cron-secret";
const SWEEP_RESULT = {
  scanned: 4,
  reaped: 2,
  skippedByRecheck: 1,
  skippedByContention: 1,
  failed: 0,
  deferred: 0,
  hasMore: false,
};

describe("GET /api/cron/reconcile-stale-sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = CRON_SECRET;
    mockRunStaleSessionSweep.mockResolvedValue(SWEEP_RESULT);
  });

  afterEach(() => {
    restoreCronSecret();
  });

  it("returns 500 without calling the service when CRON_SECRET is unset", async () => {
    Reflect.deleteProperty(process.env, "CRON_SECRET");

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockRunStaleSessionSweep).not.toHaveBeenCalled();
  });

  it("returns 401 without calling the service for a bad bearer", async () => {
    const response = await GET(makeRequest("bad-token"));

    expect(response.status).toBe(401);
    expect(mockRunStaleSessionSweep).not.toHaveBeenCalled();
  });

  it("returns counts and calls the service on success", async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockRunStaleSessionSweep).toHaveBeenCalledOnce();
    expect(await response.text()).toBe(
      "OK: scanned=4 reaped=2 skippedByRecheck=1 skippedByContention=1 failed=0 deferred=0 hasMore=false"
    );
    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it("returns 500 and alerts Slack when the service throws", async () => {
    mockRunStaleSessionSweep.mockRejectedValue(new Error("database down"));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(mockNotifySlack).toHaveBeenCalledWith({
      route: "reconcile-stale-sessions:hourly",
      message: "Stale session reconciliation failed: database down",
      correlationId: "ts=2026-07-24T18:00:00.000Z",
    });
  });

  it("alerts Slack but returns 200 when some rows fail to reap", async () => {
    mockRunStaleSessionSweep.mockResolvedValue({
      ...SWEEP_RESULT,
      failed: 3,
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(mockNotifySlack).toHaveBeenCalledWith({
      route: "reconcile-stale-sessions:hourly",
      message: "Stale session reaper: 3 row(s) failed to reap",
      correlationId: "ts=2026-07-24T18:00:00.000Z",
    });
  });
});

function makeRequest(token = CRON_SECRET): Request {
  return new Request("http://localhost/api/cron/reconcile-stale-sessions", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

function restoreCronSecret(): void {
  if (ORIGINAL_CRON_SECRET === undefined) {
    Reflect.deleteProperty(process.env, "CRON_SECRET");
    return;
  }
  process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
}
