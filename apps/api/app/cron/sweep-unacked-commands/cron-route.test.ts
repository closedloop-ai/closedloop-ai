/**
 * ISS-7223: the sweep's route. It is read-only with respect to command state,
 * but it still walks the fleet's live queued set on every call, so the
 * cron-secret guard owes real coverage rather than an assumption.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockValidateCronSecret, mockSweepUnackedCommands, mockLogError } =
  vi.hoisted(() => ({
    mockValidateCronSecret: vi.fn(),
    mockSweepUnackedCommands: vi.fn(),
    mockLogError: vi.fn(),
  }));

vi.mock("@/lib/auth/cron-secret", () => ({
  validateCronSecret: mockValidateCronSecret,
}));

vi.mock("@/lib/desktop-command-ack-timeout", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/desktop-command-ack-timeout")
  >()),
  sweepUnackedCommands: mockSweepUnackedCommands,
}));

vi.mock("@/lib/route-utils", () => ({ scheduleLogFlush: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: mockLogError, debug: vi.fn() },
}));

import { GET } from "./route";

const REQUEST = new Request("https://api.test/cron/sweep-unacked-commands");

const EMPTY_SUMMARY = {
  timedOut: 0,
  truncated: false,
  byCause: {
    target_silent: 0,
    target_busy: 0,
    target_present: 0,
    target_unknown: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateCronSecret.mockReturnValue(null);
  mockSweepUnackedCommands.mockResolvedValue(EMPTY_SUMMARY);
});

describe("GET /cron/sweep-unacked-commands", () => {
  it("refuses an unauthorized caller without sweeping", async () => {
    mockValidateCronSecret.mockReturnValue(
      new Response("Unauthorized", { status: 401 })
    );

    const response = await GET(REQUEST);

    expect(response.status).toBe(401);
    expect(mockSweepUnackedCommands).not.toHaveBeenCalled();
  });

  it("sweeps and returns the cause split for an authorized caller", async () => {
    const summary = {
      ...EMPTY_SUMMARY,
      timedOut: 2,
      byCause: { ...EMPTY_SUMMARY.byCause, target_silent: 2 },
    };
    mockSweepUnackedCommands.mockResolvedValue(summary);

    const response = await GET(REQUEST);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, summary });
  });

  it("answers 500 and names the failure instead of throwing", async () => {
    mockSweepUnackedCommands.mockRejectedValue(new Error("band read failed"));

    const response = await GET(REQUEST);

    expect(response.status).toBe(500);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining("sweep failed"),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});
