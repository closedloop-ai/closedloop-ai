import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockValidateCronSecret,
  mockDrain,
  mockScheduleLogFlush,
  mockLogError,
} = vi.hoisted(() => ({
  mockValidateCronSecret: vi.fn(),
  mockDrain: vi.fn(),
  mockScheduleLogFlush: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/auth/cron-secret", () => ({
  validateCronSecret: mockValidateCronSecret,
}));
vi.mock(
  "@/app/agent-sessions/service/artifact-links/branch-materialization-retry-drain",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/agent-sessions/service/artifact-links/branch-materialization-retry-drain")
    >()),
    drainBranchMaterializationRetries: mockDrain,
  })
);
vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: mockScheduleLogFlush,
}));
vi.mock("@repo/observability/log", () => ({
  log: { error: mockLogError, info: vi.fn() },
}));

import { BranchMaterializationRetryDrainBudget } from "@/app/agent-sessions/service/artifact-links/branch-materialization-retry-drain";
import { GET, maxDuration } from "./route";

const drainSummary = {
  claimed: 2,
  settled: 2,
  succeeded: 1,
  rescheduled: 1,
  terminal: 0,
  deadLettered: 0,
  stale: 0,
  failed: 0,
};

describe("drain Branch materialization retries cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateCronSecret.mockReturnValue(null);
    mockDrain.mockResolvedValue(drainSummary);
  });

  it("denies before claiming any retry row", async () => {
    mockValidateCronSecret.mockReturnValue(
      Response.json({ ok: false }, { status: 401 })
    );

    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("budgets the bounded serial retry batch", () => {
    expect(maxDuration).toBe(300);
    expect(maxDuration * 1000).toBe(
      BranchMaterializationRetryDrainBudget.RuntimeMs
    );
  });

  it("returns the exact summary and schedules flush after the drain", async () => {
    const response = await GET(new Request("http://localhost/cron"));

    await expect(response.json()).resolves.toEqual({
      ok: true,
      summary: drainSummary,
    });
    expect(mockDrain).toHaveBeenCalledTimes(1);
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
    expect(mockDrain.mock.invocationCallOrder[0]).toBeLessThan(
      mockScheduleLogFlush.mock.invocationCallOrder[0]
    );
  });

  it("flushes a bounded failure response without leaking the error", async () => {
    mockDrain.mockRejectedValue(new Error("sensitive retry detail"));

    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false });
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(
      "sensitive retry detail"
    );
  });
});
