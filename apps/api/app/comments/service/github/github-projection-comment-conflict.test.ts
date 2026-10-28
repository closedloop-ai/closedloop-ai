/**
 * Branch coverage for the comment-level conflict and scope-validation paths:
 * `createOrUpdateProjectedComment`'s failed create, `resolveProjectedParentCommentId`'s
 * same-thread-vs-cross-thread resolution, `findScopedThreadIdForRemoteComments`'s
 * ambiguity guard, and the two externalId scope-collision preflights
 * (`assertCommentExternalIdsAreScoped`, `assertScopedGitHubCommentExternalIdAvailable`).
 */

import { describe, expect, it, vi } from "vitest";
import {
  upsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread,
} from "./github-projection";
import { GitHubCommentProjectionScopeCollisionError } from "./github-projection-identity";

const EXTERNAL_ID_CONFLICT = "external_id_conflict";
const AMBIGUOUS_THREAD_PROJECTION = "ambiguous_thread_projection";

describe("createOrUpdateProjectedComment comment.create failure", () => {
  it("propagates a unique violation instead of querying the aborted transaction", async () => {
    const violation = { code: "P2002", meta: { target: ["external_id"] } };
    const tx = makeTx({
      commentFindManyResults: [[], []],
      createRejection: violation,
    });

    await expect(
      upsertGitHubReviewCommentThread(tx as never, makeReviewInput())
    ).rejects.toBe(violation);
    expect(tx.comment.update).not.toHaveBeenCalled();
  });
});

describe("resolveProjectedParentCommentId thread-identity branching", () => {
  it("reuses the reply's already-resolved parentCommentId without a DB lookup when the recovery thread matches", async () => {
    const tx = makeTx({
      commentFindManyResults: [[], []],
      // 1st gitHubCommentProjection.findFirst: the root's own
      // existingScopedComment check (not found -> plain create).
      // 2nd: the reply's existingScopedComment check -> found, same thread
      // as the fresh thread the reply is being upserted into.
      projectionFindFirstResults: [
        null,
        { commentId: "existing-reply", threadId: "new-thread" },
      ],
    });

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

    const rootId = (await tx.comment.create.mock.results[0].value).id;
    // Exactly two projection findFirst calls: the root's + the reply's own
    // existingScopedComment checks. A third would mean the same-thread branch
    // fell through to a DB lookup it should have skipped.
    expect(tx.gitHubCommentProjection.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.comment.update).toHaveBeenCalledWith({
      where: { id: "existing-reply" },
      data: expect.objectContaining({
        threadId: "new-thread",
        parentCommentId: rootId,
      }),
      select: { id: true, threadId: true },
    });
  });

  it("looks up the parent by remote id in the recovery thread when it differs from the reply's own thread, and resolves to null when not found there", async () => {
    const tx = makeTx({
      commentFindManyResults: [[], []],
      projectionFindFirstResults: [
        // Root's existingScopedComment check: not found.
        null,
        // Reply's existingScopedComment check: found, but scoped to a
        // DIFFERENT thread than the one it's currently being upserted into.
        { commentId: "existing-reply", threadId: "cross-thread" },
        // The cross-thread parent lookup (`findCommentIdForRemoteId`) itself
        // finds nothing in that other thread.
        null,
      ],
    });

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

    expect(tx.gitHubCommentProjection.findFirst).toHaveBeenCalledTimes(3);
    expect(tx.gitHubCommentProjection.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { threadId: "cross-thread", githubCommentId: "remote-root-1" },
      })
    );
    expect(tx.comment.update).toHaveBeenCalledWith({
      where: { id: "existing-reply" },
      data: expect.objectContaining({
        threadId: "cross-thread",
        parentCommentId: null,
      }),
      select: { id: true, threadId: true },
    });
  });
});

describe("findScopedThreadIdForRemoteComments ambiguity guard", () => {
  it("throws AmbiguousThreadProjection when the remote comment ids resolve to more than one distinct existing thread", async () => {
    const tx = makeTx({
      commentFindManyResults: [
        [],
        [{ threadId: "thread-a" }, { threadId: "thread-b" }],
      ],
    });

    await expect(
      upsertGitHubReviewCommentThread(tx as never, makeReviewInput())
    ).rejects.toMatchObject({
      code: AMBIGUOUS_THREAD_PROJECTION,
      details: expect.objectContaining({ reviewThreadId: "review-thread-1" }),
    });
  });

  it("reports a null reviewThreadId for the same ambiguity on an issue-comment thread", async () => {
    const tx = makeTx({
      commentFindManyResults: [
        [],
        [{ threadId: "thread-a" }, { threadId: "thread-b" }],
      ],
    });

    await expect(
      upsertGitHubIssueCommentThread(tx as never, {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "pr-1",
        comment: makeComment({ githubCommentId: "remote-comment-1" }),
      })
    ).rejects.toMatchObject({
      details: expect.objectContaining({ reviewThreadId: null }),
    });
  });
});

describe("assertCommentExternalIdsAreScoped", () => {
  it("throws ExternalIdConflict when an existing comment shares the externalId but its projection scope mismatches on thread kind", async () => {
    const tx = makeTx({
      commentFindManyResults: [
        [
          {
            id: "other-comment",
            threadId: "other-thread",
            externalId: "github:REVIEW_THREAD:comment:remote-root-1",
            thread: {
              organizationId: "org-1",
              artifactId: "branch-1",
              source: "GITHUB",
              githubProjection: {
                branchArtifactId: "branch-1",
                pullRequestDetailId: "pr-1",
                // Every other scope field matches; only threadKind doesn't --
                // this is a REVIEW_THREAD upsert colliding with an existing
                // ISSUE_COMMENT projection of the same remote id.
                threadKind: "ISSUE_COMMENT",
                deletedAt: null,
              },
            },
          },
        ],
      ],
    });

    await expect(
      upsertGitHubReviewCommentThread(tx as never, {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "pr-1",
        rootCommentId: "remote-root-1",
        comments: [makeComment({ githubCommentId: "remote-root-1" })],
      })
    ).rejects.toMatchObject({
      code: EXTERNAL_ID_CONFLICT,
      details: expect.objectContaining({
        githubCommentId: "remote-root-1",
        existingCommentId: "other-comment",
      }),
    });
  });
});

describe("assertScopedGitHubCommentExternalIdAvailable (issue-comment preflight)", () => {
  it("throws a scope-collision error when the externalId is already used by a comment projected to a different thread kind", async () => {
    const tx = makeTx({
      commentFindManyResults: [[], []],
      findUniqueComment: {
        thread: {
          organizationId: "org-1",
          artifactId: "branch-1",
          source: "GITHUB",
          githubProjection: {
            branchArtifactId: "branch-1",
            pullRequestDetailId: "pr-1",
            threadKind: "REVIEW_THREAD",
          },
        },
      },
    });

    await expect(
      upsertGitHubIssueCommentThread(tx as never, {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "pr-1",
        comment: makeComment({ githubCommentId: "remote-comment-1" }),
      })
    ).rejects.toBeInstanceOf(GitHubCommentProjectionScopeCollisionError);
  });
});

describe("requireRemoteCommentId", () => {
  it("rejects when a comment's githubCommentId is whitespace-only", async () => {
    const tx = makeTx({ commentFindManyResults: [[], []] });

    await expect(
      upsertGitHubReviewCommentThread(tx as never, {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "pr-1",
        rootCommentId: "remote-root-1",
        comments: [makeComment({ githubCommentId: "   " })],
      })
    ).rejects.toThrow("GitHub comment projection requires a remote comment id");
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
    reviewThreadId: "review-thread-1",
    rootCommentId: "remote-root-1",
    comments: [makeComment({ githubCommentId: "remote-root-1" })],
  };
}

/** See the sibling `github-projection-comment-linking.test.ts` for the same
 * shape of helper; this variant adds create rejection and per-call
 * `findFirst`/`findUnique` sequencing needed for the conflict paths. */
function makeTx(options: {
  commentFindManyResults: unknown[][];
  projectionFindFirstResults?: (unknown | null)[];
  createRejection?: unknown;
  findUniqueComment?: unknown | null;
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
  const commentCreate = options.createRejection
    ? vi.fn().mockRejectedValue(options.createRejection)
    : vi.fn().mockImplementation((args: { data: { threadId: string } }) => {
        nextCommentSeq += 1;
        return Promise.resolve({
          id: `comment-${nextCommentSeq}`,
          threadId: args.data.threadId,
        });
      });

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
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options.findUniqueComment === undefined
            ? null
            : options.findUniqueComment
        ),
      create: commentCreate,
      update: vi
        .fn()
        .mockImplementation(
          (args: {
            where: { id?: string; externalId?: string };
            data: { threadId: string };
          }) =>
            Promise.resolve({
              id: args.where.id ?? "recovered-comment",
              threadId: args.data.threadId,
            })
        ),
    },
    gitHubCommentProjection: {
      findFirst: projectionFindFirst,
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  };
}
