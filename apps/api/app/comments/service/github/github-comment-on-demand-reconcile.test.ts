import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  waitUntil: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: vi.fn(), info: vi.fn() },
}));

vi.mock("./github-comment-reconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-comment-reconcile")>()),
  reconcilePullRequestComments: mocks.reconcile,
}));

import {
  ON_DEMAND_RECONCILE_BUDGET_MS,
  reconcilePullRequestCommentsOnView,
} from "./github-comment-on-demand-reconcile";
import { GitHubCommentReconcileStatus } from "./github-comment-reconcile";

const PR_ID = "0190c6c8-0000-7000-8000-000000000001";
const RECONCILED = {
  status: GitHubCommentReconcileStatus.Reconciled,
  reasons: [],
  appliedEvents: 2,
  signals: 1,
} as const;

describe("reconcilePullRequestCommentsOnView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the run's result when it finishes within the budget, and keeps the run alive", async () => {
    mocks.reconcile.mockResolvedValue(RECONCILED);

    const result = await reconcilePullRequestCommentsOnView(PR_ID);

    expect(result).toEqual(RECONCILED);
    expect(mocks.reconcile).toHaveBeenCalledWith({
      pullRequestDetailId: PR_ID,
      requireAttemptDue: true,
    });
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null at the budget while the run continues under waitUntil", async () => {
    let finish: (value: typeof RECONCILED) => void = () => undefined;
    mocks.reconcile.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );

    const pending = reconcilePullRequestCommentsOnView(PR_ID);
    await vi.advanceTimersByTimeAsync(ON_DEMAND_RECONCILE_BUDGET_MS - 1);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toBeNull();
    const kept = mocks.waitUntil.mock.calls[0]?.[0];
    finish(RECONCILED);
    expect(await kept).toEqual(RECONCILED);
  });

  it("logs a run that throws and returns null so the caller serves stored rows", async () => {
    mocks.reconcile.mockRejectedValue(new Error("db down"));

    const result = await reconcilePullRequestCommentsOnView(PR_ID);

    expect(result).toBeNull();
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("on-demand comment reconcile failed"),
      expect.objectContaining({ pullRequestDetailId: PR_ID })
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
