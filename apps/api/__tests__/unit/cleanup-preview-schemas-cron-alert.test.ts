/**
 * Integration-style unit tests for the alert integration in
 * GET /api/cron/cleanup-preview-schemas.
 *
 * Verifies:
 * (a) exitCode: 1 from runDailySweep() triggers notifySlack with route identifier
 *     "cleanup-preview-schemas:daily" and forwards the counters, returning 500
 * (b) a registry-read failure (exitCode: 1) also triggers notifySlack
 * (c) exitCode: 0 (clean sweep) does NOT trigger notifySlack and returns 200
 * (d) Slack-never-throws guarantee — notifySlack rejecting does not prevent the
 *     500 response on a failed sweep
 *
 * NOTE: the route alerts iff `exitCode !== 0`. Because runDailySweep derives
 * exitCode via computeExitCode() — which is 1 whenever any category errored or a
 * registry read errored — there is no reachable "exitCode 0 with errored > 0"
 * state to test, and no "exitCode 0 + alert" path. Tests therefore drive
 * behavior through exitCode alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const { mockRunDailySweep, mockNotifySlack, mockBuildCorrelationId } =
  vi.hoisted(() => ({
    mockRunDailySweep: vi.fn(),
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

vi.mock("@/app/preview-schemas/service", () => ({
  previewSchemaCleanupService: {
    runDailySweep: mockRunDailySweep,
  },
}));

vi.mock("@/lib/slack-notifier", () => ({
  notifySlack: mockNotifySlack,
  buildCorrelationId: mockBuildCorrelationId,
}));

// scheduleLogFlush calls waitUntil which is a Vercel function — mock the
// entire route-utils module to keep tests free of platform dependencies.
vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
  // Failure path schedules the alert in the background. The handler passes an
  // already-`.catch()`-wrapped promise, so the mock can safely ignore its arg.
  scheduleLogFlushAfter: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import type { CategoryCounters } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { GET } from "@/app/cron/cleanup-preview-schemas/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(token = "test-cron-secret"): Request {
  return new Request("http://localhost/api/cron/cleanup-preview-schemas", {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
}

function makeCounters(
  overrides: Partial<CategoryCounters> = {}
): CategoryCounters {
  return {
    "ttl-expired": { kept: 0, dropped: 0, errored: 0 },
    orphan: { kept: 0, dropped: 0, errored: 0 },
    "orphan-branch": { kept: 0, dropped: 0, errored: 0 },
    "pr-closed": { kept: 0, dropped: 0, errored: 0 },
    registryReadErrored: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/cron/cleanup-preview-schemas — alert integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("(a) exitCode: 1 triggers notifySlack with route 'cleanup-preview-schemas:daily' and forwards counters", async () => {
    const counters = makeCounters({
      "ttl-expired": { kept: 0, dropped: 0, errored: 1 },
    });
    mockRunDailySweep.mockResolvedValue({
      summary: "ttl-expired[dropped=0 kept=0 errored=1]",
      counters,
      exitCode: 1,
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "cleanup-preview-schemas:daily",
        counters,
      })
    );
  });

  it("(b) a registry-read failure (exitCode: 1) triggers notifySlack", async () => {
    const counters = makeCounters({ registryReadErrored: 2 });
    mockRunDailySweep.mockResolvedValue({
      summary: "registry-read[errored=2]",
      counters,
      exitCode: 1,
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "cleanup-preview-schemas:daily",
        counters,
      })
    );
  });

  it("(c) exitCode: 0 (clean sweep) does NOT trigger notifySlack", async () => {
    mockRunDailySweep.mockResolvedValue({
      summary:
        "ttl-expired[dropped=2 kept=3 errored=0] orphan[dropped=1 kept=0 errored=0]",
      counters: makeCounters({
        "ttl-expired": { kept: 3, dropped: 2, errored: 0 },
        orphan: { kept: 0, dropped: 1, errored: 0 },
      }),
      exitCode: 0,
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it("(d) Slack-never-throws guarantee: notifySlack rejecting does not prevent 500 response on exitCode 1", async () => {
    mockRunDailySweep.mockResolvedValue({
      summary: "sweep failed",
      counters: makeCounters({
        "ttl-expired": { kept: 0, dropped: 0, errored: 1 },
      }),
      exitCode: 1,
    });
    mockNotifySlack.mockRejectedValue(new Error("Slack network error"));

    const response = await GET(makeRequest());

    // The alert was attempted (and rejected), yet the handler still returns 500.
    expect(mockNotifySlack).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
  });
});
