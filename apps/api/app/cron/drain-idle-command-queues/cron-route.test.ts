/**
 * ISS-8686: the sweep's route, which dispatches relay commands at up to
 * `IDLE_DRAIN_MAX_TARGETS_PER_TICK` targets and therefore owes its cron-secret
 * guard real coverage rather than an assumption.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockValidateCronSecret, mockDrainIdleCommandQueues, mockLogError } =
  vi.hoisted(() => ({
    mockValidateCronSecret: vi.fn(),
    mockDrainIdleCommandQueues: vi.fn(),
    mockLogError: vi.fn(),
  }));

vi.mock("@/lib/auth/cron-secret", () => ({
  validateCronSecret: mockValidateCronSecret,
}));

vi.mock("@/lib/desktop-command-idle-drain", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/desktop-command-idle-drain")
  >()),
  drainIdleCommandQueues: mockDrainIdleCommandQueues,
}));

vi.mock("@/lib/route-utils", () => ({ scheduleLogFlush: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: mockLogError, debug: vi.fn() },
}));

import { IDLE_DRAIN_BUDGET_MS } from "@/lib/desktop-command-idle-drain";
import { GET, maxDuration } from "./route";

const REQUEST = new Request("https://api.test/cron/drain-idle-command-queues");

const EMPTY_SUMMARY = {
  candidatesWithBacklog: 0,
  candidatesTruncated: false,
  targetsDue: 0,
  targetsGivenUp: 0,
  targetsSkippedByCap: 0,
  targetsSkippedByBudget: 0,
  targetsAttempted: 0,
  commandsReleased: 0,
  budgetExhausted: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateCronSecret.mockReturnValue(null);
  mockDrainIdleCommandQueues.mockResolvedValue(EMPTY_SUMMARY);
});

describe("GET /cron/drain-idle-command-queues", () => {
  it("refuses an unauthorized caller without sweeping", async () => {
    // The guard's whole job: an unauthenticated caller must not be able to make
    // the cloud dispatch commands at ten targets.
    mockValidateCronSecret.mockReturnValue(
      new Response("Unauthorized", { status: 401 })
    );

    const response = await GET(REQUEST);

    expect(response.status).toBe(401);
    expect(mockDrainIdleCommandQueues).not.toHaveBeenCalled();
  });

  it("sweeps and returns the summary for an authorized caller", async () => {
    const summary = { ...EMPTY_SUMMARY, targetsDue: 3, targetsAttempted: 3 };
    mockDrainIdleCommandQueues.mockResolvedValue(summary);

    const response = await GET(REQUEST);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, summary });
  });

  it("answers 500 and names the failure instead of throwing", async () => {
    // A 500 trips Vercel's cron alerting but does not say which read broke, so
    // the error line is the only thing that can.
    mockDrainIdleCommandQueues.mockRejectedValue(new Error("aggregate failed"));

    const response = await GET(REQUEST);

    expect(response.status).toBe(500);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining("sweep failed"),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it("declares a platform ceiling above its own wall-clock budget", () => {
    // Inheriting the platform default would terminate the function BELOW its
    // internal budget, so the budget could never bite and the summary line —
    // the only record of what the sweep did — would be lost with it.
    expect(maxDuration * 1000).toBeGreaterThan(IDLE_DRAIN_BUDGET_MS);
  });
});
