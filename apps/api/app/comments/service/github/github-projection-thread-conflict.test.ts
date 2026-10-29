/**
 * Branch coverage for the thread-identity paths in `findOrCreateGitHubThread`
 * / `updateGitHubThread`: the ambiguous-projection guards, the reuse of a
 * soft-deleted projection, the external id a write keeps, and that a write
 * failure propagates (the caller retries the whole transaction).
 */

import { describe, expect, it, vi } from "vitest";
import {
  upsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread,
} from "./github-projection";
import { GitHubProjectionNoWriteCode } from "./github-projection-identity";

const AMBIGUOUS_THREAD_PROJECTION =
  GitHubProjectionNoWriteCode.AmbiguousThreadProjection;

describe("findOrCreateGitHubThread ambiguous-projection guards", () => {
  it("throws AmbiguousThreadProjection with the reviewThreadId when more than one active projection matches", async () => {
    const tx = makeConflictTx({
      activeProjections: [{ threadId: "t-1" }, { threadId: "t-2" }],
    });

    await expect(
      upsertGitHubReviewCommentThread(tx as never, makeReviewInput())
    ).rejects.toMatchObject({
      code: AMBIGUOUS_THREAD_PROJECTION,
      details: expect.objectContaining({ reviewThreadId: "review-thread-1" }),
    });
    expect(tx.gitHubCommentThreadProjection.findMany).toHaveBeenCalledTimes(1);
  });

  it("reports a null reviewThreadId when the ambiguous active match is on an issue-comment thread", async () => {
    const tx = makeConflictTx({
      activeProjections: [{ threadId: "t-1" }, { threadId: "t-2" }],
    });

    await expect(
      upsertGitHubIssueCommentThread(tx as never, makeIssueInput())
    ).rejects.toMatchObject({
      code: AMBIGUOUS_THREAD_PROJECTION,
      details: expect.objectContaining({ reviewThreadId: null }),
    });
  });

  it("throws AmbiguousThreadProjection when more than one reusable (soft-deleted) projection matches and none is active", async () => {
    const tx = makeConflictTx({
      activeProjections: [],
      reusableProjections: [{ threadId: "t-1" }, { threadId: "t-2" }],
    });

    await expect(
      upsertGitHubReviewCommentThread(tx as never, makeReviewInput())
    ).rejects.toMatchObject({
      code: AMBIGUOUS_THREAD_PROJECTION,
      details: expect.objectContaining({ reviewThreadId: "review-thread-1" }),
    });
    expect(tx.gitHubCommentThreadProjection.findMany).toHaveBeenCalledTimes(2);
  });

  it("reports a null reviewThreadId when the ambiguous reusable match is on an issue-comment thread", async () => {
    const tx = makeConflictTx({
      activeProjections: [],
      reusableProjections: [{ threadId: "t-1" }, { threadId: "t-2" }],
    });

    await expect(
      upsertGitHubIssueCommentThread(tx as never, makeIssueInput())
    ).rejects.toMatchObject({
      details: expect.objectContaining({ reviewThreadId: null }),
    });
  });

  it("reuses a single soft-deleted projection on a revival by updating it instead of creating a new thread", async () => {
    const tx = makeConflictTx({
      activeProjections: [],
      reusableProjections: [{ threadId: "reused-thread" }],
    });

    const result = await upsertGitHubReviewCommentThread(
      tx as never,
      makeRevivalInput()
    );

    expect(result.threadId).toBe("reused-thread");
    expect(tx.commentThread.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reused-thread" } })
    );
    expect(tx.commentThread.create).not.toHaveBeenCalled();
  });

  it("brings back a single soft-deleted projection outside a revival: the write carries a live comment", async () => {
    const tx = makeConflictTx({
      activeProjections: [],
      reusableProjections: [{ threadId: "reused-thread" }],
    });

    const result = await upsertGitHubReviewCommentThread(
      tx as never,
      makeReviewInput()
    );

    expect(result.threadId).toBe("reused-thread");
    expect(tx.commentThread.create).not.toHaveBeenCalled();
    expect(tx.gitHubCommentThreadProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "reused-thread" },
        update: expect.objectContaining({ deletedAt: null }),
      })
    );
  });

  it("leaves an active projection's deletion untouched outside a revival", async () => {
    const tx = makeConflictTx({
      activeProjections: [{ threadId: "live-thread", reviewThreadId: null }],
    });

    await upsertGitHubReviewCommentThread(tx as never, makeReviewInput());

    const [upsert] =
      tx.gitHubCommentThreadProjection.upsert.mock.calls[0] ?? [];
    expect(upsert?.update.deletedAt).toBeUndefined();
  });
});

describe("findOrCreateGitHubThread external id", () => {
  it("keeps a stored review-thread identity when the write does not know it", async () => {
    const tx = makeConflictTx({
      activeProjections: [
        { threadId: "live-thread", reviewThreadId: "review-thread-1" },
      ],
    });

    await upsertGitHubReviewCommentThread(tx as never, {
      ...makeReviewInput(),
      reviewThreadId: null,
    });

    expect(tx.commentThread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalId: "github-pr-thread:pr-1:review-thread:review-thread-1",
        }),
      })
    );
  });

  it("writes the root identity while no review-thread id is known", async () => {
    const tx = makeConflictTx({
      activeProjections: [{ threadId: "live-thread", reviewThreadId: null }],
    });

    await upsertGitHubReviewCommentThread(tx as never, {
      ...makeReviewInput(),
      reviewThreadId: null,
    });

    expect(tx.commentThread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalId: "github-pr-thread:pr-1:REVIEW_THREAD:root:remote-root-1",
        }),
      })
    );
  });
});

describe("findOrCreateGitHubThread write failures", () => {
  it("propagates a commentThread.create unique violation instead of querying the aborted transaction", async () => {
    const violation = { code: "P2002", meta: { target: ["externalId"] } };
    const tx = makeConflictTx({
      activeProjections: [],
      reusableProjections: [],
      createRejection: violation,
    });

    await expect(
      upsertGitHubReviewCommentThread(tx as never, makeReviewInput())
    ).rejects.toBe(violation);
    expect(tx.commentThread.findUnique).not.toHaveBeenCalled();
  });

  it("propagates a commentThread.update unique violation instead of querying the aborted transaction", async () => {
    const violation = { code: "P2002", meta: { target: ["externalId"] } };
    const tx = makeConflictTx({
      activeProjections: [],
      reusableProjections: [{ threadId: "reused-thread" }],
      updateRejection: violation,
    });

    await expect(
      upsertGitHubReviewCommentThread(tx as never, makeRevivalInput())
    ).rejects.toBe(violation);
    expect(tx.commentThread.findUnique).not.toHaveBeenCalled();
  });
});

function makeReviewInput() {
  return {
    organizationId: "org-1",
    branchArtifactId: "branch-1",
    pullRequestDetailId: "pr-1",
    reviewThreadId: "review-thread-1",
    reviewId: "review-1",
    rootCommentId: "remote-root-1",
    comments: [
      {
        githubCommentId: "remote-comment-1",
        bodyMarkdown: "Body",
        author: { userId: "user-1" },
        createdAt: new Date("2026-05-21T12:00:00.000Z"),
      },
    ],
  };
}

/** A complete reconcile list's write: the one allowed to reuse a soft-deleted projection. */
function makeRevivalInput() {
  return { ...makeReviewInput(), revive: true };
}

function makeIssueInput() {
  return {
    organizationId: "org-1",
    branchArtifactId: "branch-1",
    pullRequestDetailId: "pr-1",
    comment: {
      githubCommentId: "remote-comment-2",
      bodyMarkdown: "Body",
      author: { userId: "user-1" },
      createdAt: new Date("2026-05-21T12:00:00.000Z"),
    },
  };
}

/**
 * A hand-rolled `GitHubProjectionDb` that exercises the real
 * `findOrCreateGitHubThread` / `updateGitHubThread` control flow. Every
 * caller configures only the fields relevant to the branch under test; the
 * rest default to a normal "brand-new thread, single comment, no reply"
 * happy path so the downstream comment-upsert code the function calls into
 * afterward does not blow up on an unconfigured mock.
 */
function makeConflictTx(options: {
  activeProjections?: { threadId: string; reviewThreadId?: string | null }[];
  reusableProjections?: { threadId: string; reviewThreadId?: string | null }[];
  createRejection?: unknown;
  updateRejection?: unknown;
}) {
  const findManyThreadProjection = vi.fn();
  findManyThreadProjection.mockResolvedValueOnce(
    options.activeProjections ?? []
  );
  if (options.reusableProjections !== undefined) {
    findManyThreadProjection.mockResolvedValueOnce(options.reusableProjections);
  }
  findManyThreadProjection.mockResolvedValue([]);

  const commentThreadCreate = options.createRejection
    ? vi.fn().mockRejectedValue(options.createRejection)
    : vi.fn().mockResolvedValue({ id: "new-thread" });

  const commentThreadUpdate = options.updateRejection
    ? vi.fn().mockRejectedValue(options.updateRejection)
    : vi
        .fn()
        .mockImplementation((args: { where: { id: string } }) =>
          Promise.resolve({ id: args.where.id })
        );

  return {
    commentThread: {
      create: commentThreadCreate,
      update: commentThreadUpdate,
      findUnique: vi.fn().mockResolvedValue(null),
    },
    gitHubCommentThreadProjection: {
      findMany: findManyThreadProjection,
      upsert: vi.fn().mockResolvedValue(undefined),
    },
    comment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      // The issue-thread entry point runs a scoped externalId preflight
      // (`assertScopedGitHubCommentExternalIdAvailable`) before it ever
      // reaches `findOrCreateGitHubThread`; default to "no existing row" so
      // that preflight always clears for these thread-identity tests.
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation((args: { data: { threadId: string } }) =>
          Promise.resolve({ id: "new-comment", threadId: args.data.threadId })
        ),
      update: vi.fn().mockResolvedValue({ id: "new-comment", threadId: "n/a" }),
    },
    gitHubCommentProjection: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  };
}
