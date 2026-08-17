/**
 * FEA-3001: unit tests for GET /api/cron/reconcile-attachment-rows.
 *
 * The sweep behind this route deletes rows, so the load-bearing assertion here
 * is the arming gate: the scheduled path carries no `?apply=1`, and the route
 * must therefore run dry. Verified in both directions so a regression that
 * hard-coded `apply: true` cannot pass.
 *
 * Also mirrors the sibling cron-route shape:
 * (a) exitCode 0 returns 200 and does NOT alert
 * (b) exitCode 1 returns 500 and alerts with the route identifier
 * (c) a rejecting notifySlack still yields the 500
 * (d) a missing/invalid CRON_SECRET short-circuits before the sweep
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const { mockRunSweep, mockNotifySlack, mockBuildCorrelationId } = vi.hoisted(
  () => ({
    mockRunSweep: vi.fn(),
    mockNotifySlack: vi.fn().mockResolvedValue(undefined),
    mockBuildCorrelationId: vi
      .fn()
      .mockReturnValue("ts=2026-01-01T00:00:00.000Z"),
  })
);

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/documents/attachment-row-reconcile-service", () => ({
  attachmentRowReconcileService: {
    runRowReconcileSweep: mockRunSweep,
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

import { GET } from "@/app/cron/reconcile-attachment-rows/route";

/** The scheduled path exactly as it appears in `apps/api/vercel.json`. */
const SCHEDULED_PATH = "http://localhost/api/cron/reconcile-attachment-rows";

function makeRequest(
  url = SCHEDULED_PATH,
  token = "test-cron-secret"
): Request {
  return new Request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

const cleanResult = {
  summary:
    "Scanned 4 attachment row(s) older than 900s; marked 1 newly absent, confirmed 0 absent on a second run, would delete 0 (dry run — no rows removed); 0 recovered, 0 indeterminate and skipped; full survey — no candidates left unexamined",
  scanned: 4,
  newlyAbsent: 1,
  orphansConfirmed: 0,
  orphansDeleted: 0,
  recovered: 0,
  ambiguous: 0,
  truncated: false,
  dryRun: true,
  exitCode: 0 as const,
};

const failedResult = {
  summary: "Attachment row reconcile sweep failed after scanning 0 row(s)",
  scanned: 0,
  newlyAbsent: 0,
  orphansConfirmed: 0,
  orphansDeleted: 0,
  recovered: 0,
  ambiguous: 0,
  truncated: false,
  dryRun: true,
  exitCode: 1 as const,
};

describe("GET /api/cron/reconcile-attachment-rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSweep.mockResolvedValue(cleanResult);
    process.env.CRON_SECRET = "test-cron-secret";
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("runs dry on the scheduled path, which carries no apply flag", async () => {
    await GET(makeRequest());

    expect(mockRunSweep).toHaveBeenCalledWith({ apply: false });
  });

  it("arms deletion only when the request carries ?apply=1", async () => {
    await GET(makeRequest(`${SCHEDULED_PATH}?apply=1`));

    expect(mockRunSweep).toHaveBeenCalledWith({ apply: true });
  });

  it("treats any other apply value as dry-run", async () => {
    await GET(makeRequest(`${SCHEDULED_PATH}?apply=true`));

    expect(mockRunSweep).toHaveBeenCalledWith({ apply: false });
  });

  it("(a) exitCode 0 returns 200 and does not alert", async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it("(b) exitCode 1 returns 500 and alerts with the route identifier", async () => {
    mockRunSweep.mockResolvedValue(failedResult);

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ route: "reconcile-attachment-rows:daily" })
    );
  });

  it("(c) a rejecting notifySlack still yields a 500", async () => {
    mockRunSweep.mockResolvedValue(failedResult);
    mockNotifySlack.mockRejectedValueOnce(new Error("slack down"));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
  });

  it("(d) rejects an invalid CRON_SECRET before sweeping", async () => {
    const response = await GET(makeRequest(SCHEDULED_PATH, "wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockRunSweep).not.toHaveBeenCalled();
  });
});
