import { GitHubCommentThreadKind } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GitHubCommentCompatibilityCode,
  resolveGitHubCommentCompatibility,
} from "./github-comment-compatibility";

describe("resolveGitHubCommentCompatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a scoped remote GitHub id to unified comment identity", async () => {
    const tx = makeTx({
      unifiedRows: [
        {
          commentId: "comment-1",
          threadId: "thread-1",
          githubCommentId: "123",
        },
      ],
    });

    await expect(
      resolveGitHubCommentCompatibility(tx as never, input("123"))
    ).resolves.toEqual({
      code: GitHubCommentCompatibilityCode.Resolved,
      commentId: "comment-1",
      threadId: "thread-1",
      githubCommentId: "123",
    });
  });

  it("does not resolve retired legacy-only ids after final cleanup", async () => {
    const tx = makeTx({
      unifiedRows: [null],
    });

    const result = await resolveGitHubCommentCompatibility(
      tx as never,
      input("legacy-1")
    );

    expect(result).toEqual({
      code: GitHubCommentCompatibilityCode.NotFound,
    });
  });

  it("resolves a thread id to the root scoped comment instead of reporting a multi-comment thread as ambiguous", async () => {
    const tx = makeTx({
      unifiedRows: [null],
      threadRow: {
        commentId: "root-comment",
        threadId: "thread-1",
        githubCommentId: "root-remote",
      },
    });

    await expect(
      resolveGitHubCommentCompatibility(tx as never, input("thread-1"))
    ).resolves.toEqual({
      code: GitHubCommentCompatibilityCode.Resolved,
      commentId: "root-comment",
      threadId: "thread-1",
      githubCommentId: "root-remote",
    });
    expect(tx.gitHubCommentProjection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1" }),
        orderBy: [{ comment: { createdAt: "asc" } }, { commentId: "asc" }],
      })
    );
  });

  it("reports shared raw GitHub ids as ambiguous when no thread kind discriminator is provided", async () => {
    const tx = makeTx({
      unifiedRows: [
        [
          {
            commentId: "issue-comment",
            threadId: "issue-thread",
            githubCommentId: "shared-raw-id",
          },
          {
            commentId: "review-comment",
            threadId: "review-thread",
            githubCommentId: "shared-raw-id",
          },
        ],
      ],
    });

    await expect(
      resolveGitHubCommentCompatibility(tx as never, input("shared-raw-id"))
    ).resolves.toEqual({
      code: GitHubCommentCompatibilityCode.Ambiguous,
    });
  });

  it("scopes shared raw GitHub ids by explicit issue comment thread kind", async () => {
    const tx = makeTx({
      unifiedRows: [
        {
          commentId: "issue-comment",
          threadId: "issue-thread",
          githubCommentId: "shared-raw-id",
        },
      ],
    });

    await expect(
      resolveGitHubCommentCompatibility(tx as never, {
        ...input("shared-raw-id"),
        threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
      })
    ).resolves.toEqual({
      code: GitHubCommentCompatibilityCode.Resolved,
      commentId: "issue-comment",
      threadId: "issue-thread",
      githubCommentId: "shared-raw-id",
    });
    expect(tx.gitHubCommentProjection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadProjection: expect.objectContaining({
            threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
          }),
        }),
      })
    );
  });

  it("scopes shared raw GitHub ids by explicit review thread kind", async () => {
    const tx = makeTx({
      unifiedRows: [
        {
          commentId: "review-comment",
          threadId: "review-thread",
          githubCommentId: "shared-raw-id",
        },
      ],
    });

    await expect(
      resolveGitHubCommentCompatibility(tx as never, {
        ...input("shared-raw-id"),
        threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      })
    ).resolves.toEqual({
      code: GitHubCommentCompatibilityCode.Resolved,
      commentId: "review-comment",
      threadId: "review-thread",
      githubCommentId: "shared-raw-id",
    });
    expect(tx.gitHubCommentProjection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadProjection: expect.objectContaining({
            threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
          }),
        }),
      })
    );
  });
});

function input(id: string) {
  return {
    organizationId: "org-1",
    branchArtifactId: "branch-1",
    pullRequestDetailId: "pr-1",
    id,
  };
}

function makeTx({
  unifiedRows,
  threadRow,
}: {
  unifiedRows: UnifiedLookupResult[];
  threadRow?: {
    commentId: string;
    threadId: string;
    githubCommentId: string;
  } | null;
}) {
  const rows = [...unifiedRows];
  return {
    gitHubCommentProjection: {
      findMany: vi.fn().mockImplementation(() => {
        const row = rows.shift();
        if (Array.isArray(row)) {
          return row;
        }
        return row ? [row] : [];
      }),
      findFirst: vi.fn().mockResolvedValue(threadRow ?? null),
    },
  };
}

type UnifiedRow = {
  commentId: string;
  threadId: string;
  githubCommentId: string;
};

type UnifiedLookupResult = UnifiedRow | UnifiedRow[] | null;
