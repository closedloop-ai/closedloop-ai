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
  findGitHubReviewThreadResolutionProjection,
  GitHubReviewThreadResolutionProjectionStatus,
  softDeleteGitHubCommentProjection,
  upsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread,
} from "./github-projection";

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
      createdGithubCommentIds: [],
    });
    expect(tx.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "winner-comment" },
        data: expect.objectContaining({
          threadId: "winner-thread",
          plainText: "Race duplicate",
          deletedAt: null,
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
          githubDeletedAt: null,
        }),
      })
    );
    expect(tx.gitHubCommentThreadProjection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "winner-thread" },
        update: expect.objectContaining({
          deletedAt: null,
          reviewThreadId: "review-thread-1",
        }),
      })
    );
  });

  it("recovers a duplicate created-delivery P2002 as an idempotent existing scoped comment", async () => {
    const tx = makeTx({
      scopedCommentResults: [
        null,
        {
          id: "winner-comment",
          threadId: "winner-thread",
        },
      ],
      uniqueErrorTarget: "Comment.external_id",
    });

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
      createdGithubCommentIds: [],
    });
    expect(tx.comment.create).toHaveBeenCalledOnce();
    expect(tx.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          externalId: "github:REVIEW_THREAD:comment:remote-comment-1",
        },
        data: expect.objectContaining({
          threadId: "winner-thread",
          plainText: "Race duplicate",
          deletedAt: null,
        }),
        select: { id: true, threadId: true },
      })
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
          .mockResolvedValue([
            { commentId: "comment-1", threadId: "thread-1" },
          ]),
        update: vi.fn(),
      },
      comment: {
        update: vi.fn(),
      },
      gitHubCommentThreadProjection: {
        findMany: vi.fn().mockResolvedValue([
          {
            threadId: "thread-1",
            commentProjections: [],
          },
        ]),
        update: vi.fn(),
      },
    };

    await softDeleteGitHubCommentProjection(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
      liveGithubCommentIds: new Set(),
      deletedAt: observedAt,
      fetchProvenance: {
        credentialType: GitHubFetchCredentialType.GitHubApp,
        mechanism: GitHubFetchMechanism.Backfill,
        trigger: GitHubFetchTrigger.Backfill,
        observedAt,
        resultReason: GitHubSyncResultReason.Success,
      },
    });

    expect(tx.gitHubCommentProjection.update).toHaveBeenCalledWith({
      where: { commentId: "comment-1" },
      data: {
        githubDeletedAt: observedAt,
        ...expectedProvenance,
      },
    });
    expect(tx.gitHubCommentThreadProjection.update).toHaveBeenCalledWith({
      where: { threadId: "thread-1" },
      data: {
        deletedAt: observedAt,
        ...expectedProvenance,
      },
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
    uniqueErrorTarget?: unknown;
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
      create: vi.fn().mockRejectedValue({
        code: "P2002",
        meta: { target: options.uniqueErrorTarget ?? ["externalId"] },
      }),
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
