import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("../service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../service")>()),
  runPullRequestCommentReconcile: mocks.run,
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
  logRequestCompleted: vi.fn(),
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) => error,
}));

import { log } from "@repo/observability/log";
import { logRequestCompleted } from "@/lib/route-utils";
import { GET } from "../route";
import {
  PullRequestCommentReconcileRunStatus,
  type PullRequestCommentReconcileRunSummary,
  RECONCILE_PR_COMMENTS_RUN_EVENT,
} from "../service";

const CRON_SECRET = "test-cron-secret";
const RUN_COMPLETED = "[reconcile-pr-comments] run completed";

function summary(
  status: PullRequestCommentReconcileRunStatus
): PullRequestCommentReconcileRunSummary {
  return {
    event: RECONCILE_PR_COMMENTS_RUN_EVENT,
    status,
    due: 9,
    overdue: 3,
    reconciled: 4,
    partial: 2,
    claimedElsewhere: 1,
    providerErrors: 1,
    failed: 1,
    appliedEvents: 12,
    signals: 7,
    reasons: [],
  };
}

function request(authorization?: string): Request {
  return new Request("https://api.test/cron/reconcile-pr-comments", {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /cron/reconcile-pr-comments", () => {
  it.each([
    ["a wrong", "Bearer wrong-secret"],
    ["a missing", undefined],
  ])(
    "rejects %s cron secret and never runs the reconcile",
    async (_, header) => {
      const response = await GET(request(header));

      expect(response.status).toBe(401);
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );

  it("logs an ok run at info and returns its counts", async () => {
    const ok = summary(PullRequestCommentReconcileRunStatus.Ok);
    mocks.run.mockResolvedValue(ok);

    const response = await GET(request(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(
      "OK: due 9, reconciled 4, partial 2, provider errors 1, failed 1"
    );
    expect(log.info).toHaveBeenCalledWith(RUN_COMPLETED, ok);
    expect(log.warn).not.toHaveBeenCalledWith(RUN_COMPLETED, ok);
    expect(logRequestCompleted).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(Number),
      200,
      undefined,
      undefined
    );
  });

  it("logs a degraded run at warn", async () => {
    const degraded = summary(PullRequestCommentReconcileRunStatus.Degraded);
    mocks.run.mockResolvedValue(degraded);

    const response = await GET(request(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    expect(log.warn).toHaveBeenCalledWith(RUN_COMPLETED, degraded);
    expect(log.info).not.toHaveBeenCalledWith(RUN_COMPLETED, degraded);
  });

  it("returns 500 when the reconcile run throws", async () => {
    mocks.run.mockRejectedValue(new Error("db down"));

    const response = await GET(request(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("reconcile-pr-comments failed");
  });
});
