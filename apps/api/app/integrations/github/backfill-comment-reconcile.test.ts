import { GitHubProviderResultStatus } from "@repo/github/provider-result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reconcileMock } = vi.hoisted(() => ({ reconcileMock: vi.fn() }));

vi.mock(
  "@/app/comments/service/github/github-comment-reconcile",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/comments/service/github/github-comment-reconcile")
    >()),
    reconcilePullRequestComments: reconcileMock,
  })
);

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

import { log } from "@repo/observability/log";
import { GitHubCommentReconcileStatus } from "@/app/comments/service/github/github-comment-reconcile";
import { backfillFetchProvenance } from "@/lib/github-fetch-provenance";
import {
  type BackfillCommentLists,
  reconcileProjectedComments,
} from "./backfill-comment-reconcile";

const LISTS: BackfillCommentLists = {
  issueComments: {
    status: GitHubProviderResultStatus.Success,
    value: { items: [], complete: true },
  },
  reviewComments: {
    status: GitHubProviderResultStatus.Success,
    value: { items: [], complete: true },
  },
  reviews: {
    status: GitHubProviderResultStatus.Success,
    value: { items: [], complete: true },
  },
  listedAt: new Date("2026-09-01T00:00:00.000Z"),
};

describe("reconcileProjectedComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reconcileMock.mockResolvedValue({
      status: GitHubCommentReconcileStatus.Reconciled,
    });
  });

  it("logs a pull request another run holds the lease for, without counting it as a failure", async () => {
    reconcileMock.mockResolvedValueOnce({
      status: GitHubCommentReconcileStatus.Claimed,
    });

    const failures = await reconcileProjectedComments(
      "acme/web",
      [{ number: 4, pullRequestDetailId: "pr-4" }],
      new Map([[4, LISTS]]),
      backfillFetchProvenance()
    );

    expect(failures).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      "[github-backfill] pull request comment reconcile skipped",
      expect.objectContaining({
        pullRequestDetailId: "pr-4",
        status: GitHubCommentReconcileStatus.Claimed,
      })
    );
  });

  it("names a pull request whose reconcile throws and still reconciles the next one", async () => {
    reconcileMock.mockRejectedValueOnce(new Error("transaction timed out"));

    const failures = await reconcileProjectedComments(
      "acme/web",
      [
        { number: 1, pullRequestDetailId: "pr-1" },
        { number: 2, pullRequestDetailId: "pr-2" },
      ],
      new Map([
        [1, LISTS],
        [2, LISTS],
      ]),
      backfillFetchProvenance()
    );

    expect(failures).toEqual(["acme/web#1:comments:rejected"]);
    expect(reconcileMock).toHaveBeenCalledTimes(2);
    expect(reconcileMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ pullRequestDetailId: "pr-2" })
    );
  });

  it("skips a projected pull request whose lists were never read", async () => {
    const failures = await reconcileProjectedComments(
      "acme/web",
      [{ number: 3, pullRequestDetailId: "pr-3" }],
      new Map(),
      backfillFetchProvenance()
    );

    expect(failures).toEqual([]);
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
