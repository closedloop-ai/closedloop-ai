import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubCommentThreadKind,
  GitHubLegacyCommentState,
  ThreadStatus,
} from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  upsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread,
} from "./github-projection";
import { softDeleteAbsentGitHubComments } from "./github-projection-delete";
import {
  findGitHubReviewThreadResolutionProjection,
  GitHubReviewThreadResolutionProjectionStatus,
} from "./github-projection-review-thread-read";

describe("findGitHubReviewThreadResolutionProjection", () => {
  it("classifies same-org review threads outside the scoped PR as wrong scope", async () => {
    const tx = makeTx({
      reviewThreadProjectionRows: [],
      outOfScopeReviewThread: { threadId: "other-thread" },
    });

    const result = await findGitHubReviewThreadResolutionProjection(
      tx as never,
      {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "pr-1",
        reviewThreadId: "review-thread-1",
      }
    );

    expect(result).toEqual({
      status: GitHubReviewThreadResolutionProjectionStatus.WrongScope,
    });
    expect(tx.gitHubCommentThreadProjection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ reviewThreadId: "review-thread-1" }]),
          thread: expect.objectContaining({
            organizationId: "org-1",
          }),
        }),
      })
    );
  });

  it("falls back to scoped review comment ids when the thread node id is not stored yet", async () => {
    const tx = makeTx({
      reviewThreadProjectionRows: [
        {
          thread: {
            id: "thread-1",
            externalId: "github-pr-thread:pr-1:review-thread:review-thread-1",
          },
        },
      ],
    });

    const result = await findGitHubReviewThreadResolutionProjection(
      tx as never,
      {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "pr-1",
        reviewThreadId: "review-thread-1",
        reviewCommentIds: ["remote-root-1", "remote-comment-2"],
      }
    );

    expect(result).toEqual({
      status: GitHubReviewThreadResolutionProjectionStatus.Eligible,
      threadId: "thread-1",
      threadExternalId: "github-pr-thread:pr-1:review-thread:review-thread-1",
    });
    expect(tx.gitHubCommentThreadProjection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { reviewThreadId: "review-thread-1" },
            { rootCommentId: "remote-root-1" },
            { rootCommentId: "remote-comment-2" },
          ]),
        }),
      })
    );
  });
});

describe("upsertGitHubReviewCommentThread", () => {
  it("reuses an existing scoped comment before creating a duplicate external id", async () => {
    const tx = makeTx();

    const result = await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      reviewThreadId: "review-thread-1",
      reviewId: "review-1",
      rootCommentId: "remote-root-1",
      path: "src/app.ts",
      line: 42,
      legacyState: GitHubLegacyCommentState.PENDING,
      comments: [
        {
          githubCommentId: "remote-comment-1",
          bodyMarkdown: "Race duplicate",
          author: { userId: "user-1", externalAuthorId: "author-1" },
          createdAt: new Date("2026-05-21T12:00:00.000Z"),
        },
      ],
    });

    expect(result).toEqual({
      threadId: "winner-thread",
      commentIds: ["winner-comment"],
    });
    expect(tx.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "winner-comment" },
        data: expect.objectContaining({
          threadId: "winner-thread",
          plainText: "Race duplicate",
        }),
        select: { id: true, threadId: true },
      })
    );
    expect(tx.comment.create).not.toHaveBeenCalled();
    expect(tx.gitHubCommentProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { commentId: "winner-comment" },
        create: expect.objectContaining({
          threadId: "winner-thread",
          githubCommentId: "remote-comment-1",
        }),
        update: expect.objectContaining({
          threadId: "winner-thread",
          githubCommentId: "remote-comment-1",
        }),
      })
    );
    expect(tx.gitHubCommentThreadProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "winner-thread" },
        update: expect.objectContaining({
          reviewThreadId: "review-thread-1",
        }),
      })
    );
    // PLN-2122 decision 2: outside a revival no write clears a deletion.
    expect(tx.comment.update.mock.calls[0]?.[0].data).not.toHaveProperty(
      "deletedAt"
    );
    expect(
      tx.gitHubCommentProjection.upsert.mock.calls[0]?.[0].update
    ).not.toHaveProperty("githubDeletedAt");
    expect(
      tx.gitHubCommentThreadProjection.upsert.mock.calls[0]?.[0].update
        .deletedAt
    ).toBeUndefined();
  });

  it("clears a stored deletion only on a revival (PLN-2122 decision 2)", async () => {
    const tx = makeTx();

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      reviewThreadId: "review-thread-1",
      reviewId: "review-1",
      rootCommentId: "remote-root-1",
      revive: true,
      comments: [
        {
          githubCommentId: "remote-comment-1",
          bodyMarkdown: "Revived",
          author: { userId: "user-1", externalAuthorId: "author-1" },
          createdAt: new Date("2026-05-21T12:00:00.000Z"),
        },
      ],
    });

    expect(tx.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: null }),
      })
    );
    expect(tx.gitHubCommentProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ githubDeletedAt: null }),
      })
    );
    expect(tx.gitHubCommentThreadProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ deletedAt: null }),
      })
    );
  });

  it("stores a projected comment's markdown body with its bodyFormat (ISS-11212)", async () => {
    const tx = makeTx({
      scopedCommentResults: [
        { id: "winner-comment", threadId: "winner-thread" },
        null,
      ],
    });
    const comment = {
      bodyMarkdown: "**Markdown** body",
      author: { userId: "user-1", externalAuthorId: "author-1" },
      createdAt: new Date("2026-05-21T12:00:00.000Z"),
    };

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      reviewThreadId: "review-thread-1",
      reviewId: "review-1",
      rootCommentId: "remote-root-1",
      path: "src/app.ts",
      line: 42,
      legacyState: GitHubLegacyCommentState.PENDING,
      comments: [
        { ...comment, githubCommentId: "remote-comment-1" },
        { ...comment, githubCommentId: "remote-comment-2" },
      ],
    });

    const markdownBody = {
      body: { type: "github_markdown", markdown: "**Markdown** body" },
      bodyFormat: CommentBodyFormat.Markdown,
    };
    expect(tx.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(markdownBody) })
    );
    expect(tx.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(markdownBody) })
    );
  });

  it("preserves canonical resolved status when legacy state is pending without resolutionStatus", async () => {
    const tx = makeTx({
      reviewThreadProjectionRows: [{ threadId: "thread-1" }],
    });

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      reviewThreadId: "review-thread-1",
      reviewId: "review-1",
      rootCommentId: "remote-root-1",
      path: "src/app.ts",
      line: 42,
      legacyState: GitHubLegacyCommentState.PENDING,
      comments: [makeReviewCommentInput()],
    });

    expect(tx.commentThread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "thread-1" },
        data: expect.not.objectContaining({ status: expect.anything() }),
      })
    );
    expect(tx.gitHubCommentThreadProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          legacyState: GitHubLegacyCommentState.PENDING,
        }),
        update: expect.objectContaining({
          legacyState: GitHubLegacyCommentState.PENDING,
        }),
      })
    );
  });

  it("creates canonical status from explicit resolutionStatus", async () => {
    const tx = makeTx({
      scopedCommentResults: [null],
    });

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      reviewThreadId: "review-thread-1",
      reviewId: "review-1",
      rootCommentId: "remote-root-1",
      path: "src/app.ts",
      line: 42,
      legacyState: GitHubLegacyCommentState.PENDING,
      resolutionStatus: ThreadStatus.RESOLVED,
      comments: [makeReviewCommentInput()],
    });

    expect(tx.commentThread.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ThreadStatus.RESOLVED,
        }),
      })
    );
    expect(tx.gitHubCommentThreadProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          legacyState: GitHubLegacyCommentState.PENDING,
        }),
      })
    );
  });

  it("updates canonical status only when explicit resolutionStatus is present", async () => {
    const tx = makeTx({
      reviewThreadProjectionRows: [{ threadId: "thread-1" }],
    });

    await upsertGitHubReviewCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      reviewThreadId: "review-thread-1",
      reviewId: "review-1",
      rootCommentId: "remote-root-1",
      path: "src/app.ts",
      line: 42,
      legacyState: GitHubLegacyCommentState.PENDING,
      resolutionStatus: ThreadStatus.OPEN,
      comments: [makeReviewCommentInput()],
    });

    expect(tx.commentThread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "thread-1" },
        data: expect.objectContaining({
          status: ThreadStatus.OPEN,
        }),
      })
    );
  });

  it("stamps supplied fetch provenance on thread and comment projections", async () => {
    const tx = makeTx();
    const observedAt = new Date("2026-07-05T12:00:00.000Z");
    const expectedProvenance = {
      fetchCredentialType: GitHubFetchCredentialType.GitHubApp,
      fetchCredentialOwnerId: null,
      fetchMechanism: GitHubFetchMechanism.Webhook,
      fetchTrigger: GitHubFetchTrigger.Webhook,
      fetchObservedAt: observedAt,
      fetchResultReason: GitHubSyncResultReason.Success,
    };

    await upsertGitHubIssueCommentThread(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      fetchProvenance: {
        credentialType: GitHubFetchCredentialType.GitHubApp,
        mechanism: GitHubFetchMechanism.Webhook,
        trigger: GitHubFetchTrigger.Webhook,
        observedAt,
        resultReason: GitHubSyncResultReason.Success,
      },
      comment: makeReviewCommentInput(),
    });

    expect(tx.gitHubCommentThreadProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining(expectedProvenance),
        update: expect.objectContaining(expectedProvenance),
      })
    );
    expect(tx.gitHubCommentProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining(expectedProvenance),
        update: expect.objectContaining(expectedProvenance),
      })
    );
  });

  it("stamps supplied fetch provenance on soft-deleted comment and thread projections", async () => {
    const observedAt = new Date("2026-07-05T12:00:00.000Z");
    const expectedProvenance = {
      fetchCredentialType: GitHubFetchCredentialType.GitHubApp,
      fetchCredentialOwnerId: null,
      fetchMechanism: GitHubFetchMechanism.Backfill,
      fetchTrigger: GitHubFetchTrigger.Backfill,
      fetchObservedAt: observedAt,
      fetchResultReason: GitHubSyncResultReason.Success,
    };
    const tx = {
      gitHubCommentProjection: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              commentId: "comment-1",
              threadId: "thread-1",
              githubCommentId: "1",
            },
          ])
          .mockResolvedValueOnce([]),
        updateManyAndReturn: vi
          .fn()
          .mockResolvedValue([{ commentId: "comment-1" }]),
      },
      comment: {
        update: vi.fn(),
      },
      gitHubCommentThreadProjection: {
        update: vi.fn(),
      },
    };

    await softDeleteAbsentGitHubComments(
      tx as never,
      {
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pullRequestDetailId: "pr-1",
        threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
        liveGithubCommentIds: new Set(),
        listedAt: observedAt,
        maxComments: 50,
        deletedAt: observedAt,
        fetchProvenance: {
          credentialType: GitHubFetchCredentialType.GitHubApp,
          mechanism: GitHubFetchMechanism.Backfill,
          trigger: GitHubFetchTrigger.Backfill,
          observedAt,
          resultReason: GitHubSyncResultReason.Success,
        },
      },
      () => Promise.resolve()
    );

    expect(tx.gitHubCommentProjection.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          githubDeletedAt: observedAt,
          ...expectedProvenance,
        },
        select: { commentId: true },
      })
    );
    expect(tx.gitHubCommentThreadProjection.update).toHaveBeenCalledWith({
      where: { threadId: "thread-1" },
      data: {
        deletedAt: observedAt,
        ...expectedProvenance,
      },
      select: { threadId: true },
    });
  });
});

function makeReviewCommentInput() {
  return {
    githubCommentId: "remote-comment-1",
    bodyMarkdown: "Projection status",
    author: { userId: "user-1", externalAuthorId: "author-1" },
    createdAt: new Date("2026-05-21T12:00:00.000Z"),
  };
}

function makeTx(
  options: {
    scopedCommentResults?: ({ id: string; threadId: string } | null)[];
    reviewThreadProjectionRows?: unknown[];
    outOfScopeReviewThread?: { threadId: string } | null;
  } = {}
) {
  const findFirst = vi.fn();
  for (const result of options.scopedCommentResults ?? [
    {
      id: "winner-comment",
      threadId: "winner-thread",
    },
  ]) {
    findFirst.mockResolvedValueOnce(result);
  }
  findFirst.mockResolvedValue({
    id: "winner-comment",
    threadId: "winner-thread",
  });

  return {
    commentThread: {
      create: vi.fn().mockResolvedValue({ id: "loser-thread" }),
      update: vi.fn().mockResolvedValue({ id: "thread-1" }),
      findUnique: vi.fn(),
    },
    gitHubCommentThreadProjection: {
      findMany: vi
        .fn()
        .mockResolvedValue(options.reviewThreadProjectionRows ?? []),
      findFirst: vi
        .fn()
        .mockResolvedValue(options.outOfScopeReviewThread ?? null),
      upsert: vi.fn(),
    },
    comment: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst,
      create: vi
        .fn()
        .mockImplementation((args: { data: { threadId: string } }) =>
          Promise.resolve({ id: "new-comment", threadId: args.data.threadId })
        ),
      update: vi.fn().mockResolvedValue({
        id: "winner-comment",
        threadId: "winner-thread",
      }),
    },
    gitHubCommentProjection: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
    },
  };
}
