import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  runNext: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("../service", () => ({
  githubPullRequestReconcilerService: { run: mocks.run },
}));

vi.mock("@/app/branches/branch-push-backfill-service", () => ({
  branchPushBackfillService: { runNext: mocks.runNext },
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
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

import { GET } from "../route";
import type { GitHubReconcileSweepSummary } from "../service";

const CRON_SECRET = "test-cron-secret";

const SUMMARY: GitHubReconcileSweepSummary = {
  reposSelected: 11,
  reposSwept: 5,
  reposDeferredBudget: 2,
  reposDeferredContention: 1,
  reposReclassified: 1,
  reposFailed: 2,
  pullRequestsWritten: 17,
};

function authorizedRequest(): Request {
  return new Request("https://api.test/cron/reconcile-pull-requests", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  mocks.runNext.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /cron/reconcile-pull-requests", () => {
  it("rejects a request without a valid cron secret and never runs the service", async () => {
    const response = await GET(
      new Request("https://api.test/cron/reconcile-pull-requests", {
        headers: { authorization: "Bearer wrong-secret" },
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.runNext).not.toHaveBeenCalled();
  });

  it("returns the exact sweep summary on success", async () => {
    mocks.run.mockResolvedValue(SUMMARY);

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.runNext).toHaveBeenCalledOnce();
    expect(mocks.waitUntil).toHaveBeenCalledOnce();
    await expect(response.text()).resolves.toBe(
      "OK: swept 5, deferred 2 budget / 1 contention, reclassified 1, failed 2, wrote 17"
    );
  });

  it("returns the exact failure response when the service throws", async () => {
    mocks.run.mockRejectedValue(new Error("db down"));

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(500);
    expect(mocks.runNext).toHaveBeenCalledOnce();
    await expect(response.text()).resolves.toBe(
      "reconcile-pull-requests failed"
    );
  });

  it("keeps a successful PR sweep response when independent pusher backfill fails", async () => {
    mocks.run.mockResolvedValue(SUMMARY);
    mocks.runNext.mockRejectedValue(new Error("backfill unavailable"));

    const response = await GET(authorizedRequest());
    await mocks.waitUntil.mock.calls[0]?.[0];

    expect(response.status).toBe(200);
    expect(mocks.runNext).toHaveBeenCalledOnce();
    expect(mocks.waitUntil).toHaveBeenCalledOnce();
    await expect(response.text()).resolves.toBe(
      "OK: swept 5, deferred 2 budget / 1 contention, reclassified 1, failed 2, wrote 17"
    );
  });
});
