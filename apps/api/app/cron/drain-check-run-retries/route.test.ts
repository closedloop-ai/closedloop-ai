import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDrain, mockLogInfo, mockLogWarn, mockValidateCronSecret } =
  vi.hoisted(() => ({
    mockDrain: vi.fn(),
    mockLogInfo: vi.fn(),
    mockLogWarn: vi.fn(),
    mockValidateCronSecret: vi.fn(),
  }));

vi.mock("@/lib/auth/cron-secret", () => ({
  validateCronSecret: mockValidateCronSecret,
}));
vi.mock("@/lib/branch-status-check-retry-drain", () => ({
  drainDueCheckRunRetries: mockDrain,
}));
vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({
  log: { info: mockLogInfo, warn: mockLogWarn },
}));

import type { CheckRunRetryDrainSummary } from "@/lib/branch-status-check-retry-drain";
import { GET } from "./route";

const cleanSummary: CheckRunRetryDrainSummary = {
  claimed: 1,
  succeeded: 1,
  rescheduled: 0,
  deadLettered: 0,
  discarded: 0,
  missing: 0,
  failures: [],
};

describe("drain check_run retries cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDrain.mockResolvedValue(cleanSummary);
    mockValidateCronSecret.mockReturnValue(null);
  });

  it("logs a run with no provider failures at info", async () => {
    await GET(new Request("http://localhost/cron"));

    expect(mockLogInfo).toHaveBeenCalledWith(
      "[drain-check-run-retries] Drained check_run retries",
      cleanSummary
    );
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("warns when a provider read failed and the claim was only rescheduled", async () => {
    const rescheduledSummary: CheckRunRetryDrainSummary = {
      ...cleanSummary,
      succeeded: 0,
      rescheduled: 1,
      failures: [
        {
          branchArtifactId: "branch-1",
          organizationId: "org-1",
          reason: StatusCheckRollupFailureReason.RateLimited,
          deadLettered: false,
        },
      ],
    };
    mockDrain.mockResolvedValue(rescheduledSummary);

    await GET(new Request("http://localhost/cron"));

    expect(mockLogWarn).toHaveBeenCalledWith(
      "[drain-check-run-retries] Drained check_run retries with provider failures",
      rescheduledSummary
    );
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it("warns with the failed claims when a provider read failed", async () => {
    const failedSummary: CheckRunRetryDrainSummary = {
      ...cleanSummary,
      succeeded: 0,
      deadLettered: 1,
      failures: [
        {
          branchArtifactId: "branch-1",
          organizationId: "org-1",
          reason: StatusCheckRollupFailureReason.GraphqlError,
          deadLettered: true,
        },
      ],
    };
    mockDrain.mockResolvedValue(failedSummary);

    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(200);
    expect(mockLogWarn).toHaveBeenCalledWith(
      "[drain-check-run-retries] Drained check_run retries with provider failures",
      failedSummary
    );
    expect(mockLogInfo).not.toHaveBeenCalled();
  });
});
