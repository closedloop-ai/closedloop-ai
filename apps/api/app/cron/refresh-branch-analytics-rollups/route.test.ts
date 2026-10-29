import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockClassifyFailure,
  mockLogError,
  mockLogInfo,
  mockLogWarn,
  mockRefresh,
  mockScheduleLogFlush,
  mockValidateCronSecret,
} = vi.hoisted(() => ({
  mockClassifyFailure: vi.fn(),
  mockLogError: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockRefresh: vi.fn(),
  mockScheduleLogFlush: vi.fn(),
  mockValidateCronSecret: vi.fn(),
}));

vi.mock("@/lib/auth/cron-secret", () => ({
  validateCronSecret: mockValidateCronSecret,
}));
vi.mock("@/app/branches/branch-analytics-rollup", () => ({
  refreshDueBranchAnalyticsRollups: mockRefresh,
}));
vi.mock("@/app/branches/branch-analytics-rollup-failure", () => ({
  classifyBranchAnalyticsRollupFailure: mockClassifyFailure,
}));
vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: mockScheduleLogFlush,
}));
vi.mock("@repo/observability/log", () => ({
  log: { error: mockLogError, info: mockLogInfo, warn: mockLogWarn },
}));

import type { BranchAnalyticsRollupDueSummary } from "@/app/branches/branch-analytics-rollup-contract";
import { GET, maxDuration } from "./route";

// Typed, not a bare literal: this fixture IS the route's response body, so a
// contract field added or renamed must fail typecheck here rather than let the
// route keep asserting a shape it no longer returns.
const refreshSummary: BranchAnalyticsRollupDueSummary = {
  organizations: 1,
  batches: 1,
  sessionsRefreshed: 2,
  upsertedRows: 4,
  completeOrganizations: 1,
  incompleteOrganizations: 0,
  failedOrganizations: 0,
  failureCategories: [],
  failures: [],
  maxLagSeconds: 0,
  organizationLimitReached: false,
  budgetExhausted: false,
  oldestDueAsOfAgeMs: 240_000,
  neverRolledUpOrganizations: 0,
};

describe("refresh Branch analytics rollups cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClassifyFailure.mockReturnValue("sqlstate_57014");
    mockRefresh.mockResolvedValue(refreshSummary);
    mockValidateCronSecret.mockReturnValue(null);
  });

  it("denies before refreshing rollups", async () => {
    mockValidateCronSecret.mockReturnValue(
      Response.json({ ok: false }, { status: 401 })
    );

    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(401);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("uses the bounded cron runtime", () => {
    expect(maxDuration).toBe(300);
  });

  it("returns the refresh summary and schedules a log flush", async () => {
    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      summary: refreshSummary,
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("logs a clean run as complete at info", async () => {
    await GET(new Request("http://localhost/cron"));

    expect(mockLogInfo).toHaveBeenCalledWith(
      "[refresh-branch-analytics-rollups] refresh complete",
      refreshSummary
    );
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("warns with the failed organizations instead of logging complete", async () => {
    const failedSummary: BranchAnalyticsRollupDueSummary = {
      ...refreshSummary,
      failedOrganizations: 1,
      failureCategories: ["sqlstate_57014"],
      failures: [
        { organizationId: "org-failing", failureCategory: "sqlstate_57014" },
      ],
    };
    mockRefresh.mockResolvedValue(failedSummary);

    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(200);
    expect(mockLogWarn).toHaveBeenCalledWith(
      "[refresh-branch-analytics-rollups] refresh finished with failed organizations",
      failedSummary
    );
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it("classifies failures without leaking the thrown error", async () => {
    mockRefresh.mockRejectedValue(new Error("raw database detail"));

    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false });
    expect(mockClassifyFailure).toHaveBeenCalledTimes(1);
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(
      "raw database detail"
    );
  });
});
