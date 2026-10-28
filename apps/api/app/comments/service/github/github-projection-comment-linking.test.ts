/**
 * Branch coverage for `upsertProjectedGitHubComments`'s comment-linking
 * behavior: the empty-comments guard, rerouting onto an already-scoped
 * thread discovered via remote comment ids, reply-to (`githubInReplyToCommentId`)
 * resolution from the in-memory map vs. a DB lookup, the `externalAuthorId`
 * and `githubUpdatedAt` optional-field fallbacks on the projection upsert,
 * and the parent-link backfill pass.
 */

import { describe, expect, it, vi } from "vitest";
import { upsertGitHubReviewCommentThread } from "./github-projection";

describe("upsertGitHubReviewCommentThread comments guard", () => {
  it("throws before touching the database when comments is empty", async () => {
    await expect(
      upsertGitHubReviewCommentThread({} as never, {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "pr-1",
        rootCommentId: "remote-root-1",
        comments: [],
      })
    ).rejects.toThrow("GitHub review thread requires at least one comment");
  });
});

describe("upsertProjectedGitHubComments thread rerouting", () => {
  it("reroutes onto a thread already scoped to the remote comment ids when it differs from the freshly resolved thread", async () => {
    const tx = makeTx({
      commentFindManyResults: [
        // 1st call: assertCommentExternalIdsAreScoped sees no conflicts.
        [],
        // 2nd call: findScopedThreadIdForRemoteComments finds one existing
        // scoped thread, distinct from the "new-thread" findOrCreateGitHubThread
        // just created.
        [{ threadId: "existing-thread-x" }],
      ],
    });

    const result = await upsertGitHubReviewCommentThread(
      tx as never,
      makeReviewInput()
    );

    expect(result.threadId).toBe("existing-thread-x");
    expect(tx.gitHubCommentThreadProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "existing-thread-x" } })
    );
    expect(tx.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ threadId: "existing-thread-x" }),
      })
    );
  });

  it("keeps the freshly resolved thread when no scoped thread is found for the remote comment ids", async () => {
    const tx = makeTx({ commentFindManyResults: [[], []] });

    const result = await upsertGitHubReviewCommentThread(
      tx as never,
      makeReviewInput()
    );

    expect(result.threadId).toBe("new-thread");
    // Only the one upsert from `upsertGitHubThread`'s own call — no reroute.
    expect(tx.gitHubCommentThreadProjection.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("upsertProjectedGitHubComments reply-to resolution", () => {
  it("resolves a reply's parent from the in-memory map when the parent was upserted earlier in the same call", async () => {
    const tx = makeTx({ commentFindManyResults: [[], []] });

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      rootCommentId: "remote-root-1",
      comments: [
        makeComment({ githubCommentId: "remote-root-1" }),
        makeComment({
          githubCommentId: "remote-reply-1",
          githubInReplyToCommentId: "remote-root-1",
        }),
      ],
    });

    // Every comment also does its own existingScopedComment lookup via
    // `findScopedProjectionCommentByRemoteId` (gitHubCommentProjection.findFirst),
    // so two comments means exactly two such calls. A third call would mean
    // the reply-to id ALSO went through `findCommentIdForRemoteId`'s DB
    // lookup instead of resolving from the in-memory map.
    expect(tx.gitHubCommentProjection.findFirst).toHaveBeenCalledTimes(2);
    const secondCreateCall = tx.comment.create.mock.calls[1];
    const firstCreateResult = await tx.comment.create.mock.results[0].value;
    expect(secondCreateCall[0].data.parentCommentId).toBe(firstCreateResult.id);
  });

  it("falls back to a DB lookup for the reply's parent when it was not upserted in this call", async () => {
    const tx = makeTx({
      commentFindManyResults: [[], []],
      projectionFindFirstResults: [{ commentId: "parent-comment-db" }],
    });

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      rootCommentId: "remote-reply-only",
      comments: [
        makeComment({
          githubCommentId: "remote-reply-only",
          githubInReplyToCommentId: "remote-root-elsewhere",
        }),
      ],
    });

    expect(tx.gitHubCommentProjection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          githubCommentId: "remote-root-elsewhere",
        }),
      })
    );
    expect(tx.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentCommentId: "parent-comment-db" }),
      })
    );
  });
});

describe("upsertProjectedGitHubComments optional-field fallbacks", () => {
  it("defaults externalAuthorId and githubUpdatedAt to null on both the create and update upsert branches when absent", async () => {
    const tx = makeTx({ commentFindManyResults: [[], []] });

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      rootCommentId: "remote-root-1",
      comments: [
        {
          githubCommentId: "remote-root-1",
          bodyMarkdown: "No author id, no updated-at",
          author: { userId: "user-1" },
          createdAt: new Date("2026-05-21T12:00:00.000Z"),
        },
      ],
    });

    expect(tx.gitHubCommentProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          externalAuthorId: null,
          githubUpdatedAt: null,
        }),
        update: expect.objectContaining({
          externalAuthorId: null,
          githubUpdatedAt: null,
        }),
      })
    );
  });

  it("returns a non-null editedAt when githubUpdatedAt differs from createdAt", async () => {
    const tx = makeTx({ commentFindManyResults: [[], []] });
    const createdAt = new Date("2026-05-21T12:00:00.000Z");
    const githubUpdatedAt = new Date("2026-05-22T09:00:00.000Z");

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      rootCommentId: "remote-root-1",
      comments: [
        {
          githubCommentId: "remote-root-1",
          bodyMarkdown: "Edited",
          githubUpdatedAt,
          author: { userId: "user-1" },
          createdAt,
        },
      ],
    });

    expect(tx.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ editedAt: githubUpdatedAt }),
      })
    );
  });
});

describe("backfillGitHubCommentParentLinks", () => {
  it("re-writes an already-correct parent link on backfill for root-first ordering, but skips the parentless root", async () => {
    // pins current behavior; looks odd because the reply's parentCommentId is
    // already correctly set at create time (root-first order resolves it from
    // the in-memory map, see the "resolves a reply's parent" case above) — the
    // backfill pass has no memory of that and unconditionally re-writes any
    // link whose resolved parent isn't the comment's own id, producing one
    // redundant `comment.update` rather than a true no-op.
    const tx = makeTx({ commentFindManyResults: [[], []] });

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      rootCommentId: "remote-root-1",
      comments: [
        makeComment({ githubCommentId: "remote-root-1" }),
        makeComment({
          githubCommentId: "remote-reply-1",
          githubInReplyToCommentId: "remote-root-1",
        }),
      ],
    });

    const rootCommentId = (await tx.comment.create.mock.results[0].value).id;
    const replyCommentId = (await tx.comment.create.mock.results[1].value).id;
    expect(tx.comment.update).toHaveBeenCalledTimes(1);
    expect(tx.comment.update).toHaveBeenCalledWith({
      where: { id: replyCommentId },
      data: { parentCommentId: rootCommentId },
      select: { id: true },
    });
  });

  it("re-links a comment once its parent becomes resolvable later in the same call, when the parent id differs from the child's own id", async () => {
    const tx = makeTx({ commentFindManyResults: [[], []] });

    // Reply-first ordering: the reply is projected before its parent exists
    // anywhere the loop has seen, so create-time resolution leaves its
    // parentCommentId null; only the backfill pass (which runs after every
    // comment in the payload has been upserted) can link it.
    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      rootCommentId: "remote-root-1",
      comments: [
        makeComment({
          githubCommentId: "remote-reply-1",
          githubInReplyToCommentId: "remote-root-1",
        }),
        makeComment({ githubCommentId: "remote-root-1" }),
      ],
    });

    const rootCommentId = (await tx.comment.create.mock.results[1].value).id;
    const replyCommentId = (await tx.comment.create.mock.results[0].value).id;
    expect(tx.comment.update).toHaveBeenCalledWith({
      where: { id: replyCommentId },
      data: { parentCommentId: rootCommentId },
      select: { id: true },
    });
  });
});

function makeComment(overrides: {
  githubCommentId: string;
  githubInReplyToCommentId?: string;
}) {
  return {
    githubCommentId: overrides.githubCommentId,
    githubInReplyToCommentId: overrides.githubInReplyToCommentId ?? null,
    bodyMarkdown: `Body for ${overrides.githubCommentId}`,
    author: { userId: "user-1" },
    createdAt: new Date("2026-05-21T12:00:00.000Z"),
  };
}

function makeReviewInput() {
  return {
    organizationId: "org-1",
    branchArtifactId: "branch-1",
    pullRequestDetailId: "pr-1",
    rootCommentId: "remote-root-1",
    comments: [makeComment({ githubCommentId: "remote-root-1" })],
  };
}

/**
 * A hand-rolled `GitHubProjectionDb` covering the full write path (thread
 * resolution through comment upsert and parent-link backfill). `comment.create`
 * derives its resolved id/threadId from the call args so multi-comment tests
 * can distinguish which create() produced which row without needing a fixed
 * id map ahead of time.
 */
function makeTx(options: {
  commentFindManyResults: unknown[][];
  projectionFindFirstResults?: (unknown | null)[];
}) {
  const commentFindMany = vi.fn();
  for (const result of options.commentFindManyResults) {
    commentFindMany.mockResolvedValueOnce(result);
  }
  commentFindMany.mockResolvedValue([]);

  const projectionFindFirst = vi.fn();
  for (const result of options.projectionFindFirstResults ?? []) {
    projectionFindFirst.mockResolvedValueOnce(result);
  }
  projectionFindFirst.mockResolvedValue(null);

  let nextCommentSeq = 0;

  return {
    commentThread: {
      create: vi.fn().mockResolvedValue({ id: "new-thread" }),
      update: vi
        .fn()
        .mockImplementation((args: { where: { id: string } }) =>
          Promise.resolve({ id: args.where.id })
        ),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    gitHubCommentThreadProjection: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
    },
    comment: {
      findMany: commentFindMany,
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation((args: { data: { threadId: string } }) => {
          nextCommentSeq += 1;
          return Promise.resolve({
            id: `comment-${nextCommentSeq}`,
            threadId: args.data.threadId,
          });
        }),
      update: vi.fn().mockResolvedValue({ id: "updated-comment" }),
    },
    gitHubCommentProjection: {
      findFirst: projectionFindFirst,
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  };
}
