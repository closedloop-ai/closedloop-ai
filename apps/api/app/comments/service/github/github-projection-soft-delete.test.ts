/**
 * Branch coverage for the two soft-delete sweep paths: the bulk
 * `softDeleteAbsentGitHubComments` (whole-thread-kind reconciliation) and
 * the single-remote-id `softDeleteGitHubCommentRowsByRemoteId`. Both compute
 * "does this thread still have a live comment" over a set of threads and must
 * skip marking a thread deleted when at least one does, while still marking
 * the ones that don't.
 */

import { GitHubCommentThreadKind } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  softDeleteAbsentGitHubComments,
  softDeleteGitHubCommentRowsByRemoteId,
} from "./github-projection-delete";

const LISTED_AT = new Date("2026-07-05T12:00:00.500Z");

function absentInput(maxComments = 50) {
  return {
    organizationId: "org-1",
    branchArtifactId: "branch-1",
    pullRequestDetailId: "pr-1",
    threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
    liveGithubCommentIds: new Set(["live-1"]),
    listedAt: LISTED_AT,
    maxComments,
    deletedAt: new Date("2026-07-05T12:01:00.000Z"),
  };
}

/** A transaction whose stale read finds `stale` and whose deletes all land. */
function absentTx(
  stale: { commentId: string; threadId: string; githubCommentId: string }[],
  threadsWithLiveComments: string[] = []
) {
  return {
    gitHubCommentProjection: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(
          threadsWithLiveComments.map((threadId) => ({ threadId }))
        ),
      updateManyAndReturn: vi
        .fn()
        .mockResolvedValue(stale.map(({ commentId }) => ({ commentId }))),
    },
    comment: { update: vi.fn() },
    gitHubCommentThreadProjection: { findMany: vi.fn(), update: vi.fn() },
  };
}

describe("softDeleteAbsentGitHubComments", () => {
  it("leaves a thread's deletedAt untouched when one of its projections is still live", async () => {
    const tx = absentTx(
      [{ commentId: "comment-1", threadId: "thread-1", githubCommentId: "9" }],
      ["thread-1"]
    );

    const result = await softDeleteAbsentGitHubComments(
      tx as never,
      absentInput(),
      () => Promise.resolve()
    );

    expect(result.deletedThreadCount).toBe(0);
    expect(tx.gitHubCommentThreadProjection.update).not.toHaveBeenCalled();
  });

  it("reads at most maxComments stale comments per call", async () => {
    const tx = absentTx([]);

    await softDeleteAbsentGitHubComments(tx as never, absentInput(2), () =>
      Promise.resolve()
    );

    expect(tx.gitHubCommentProjection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 })
    );
  });

  it("locks the stale comments, then deletes only those still older than the list", async () => {
    const order: string[] = [];
    const tx = absentTx([
      { commentId: "comment-1", threadId: "thread-1", githubCommentId: "9" },
      { commentId: "comment-2", threadId: "thread-1", githubCommentId: "10" },
    ]);
    tx.gitHubCommentProjection.updateManyAndReturn.mockImplementation(() => {
      order.push("write");
      return Promise.resolve([{ commentId: "comment-2" }]);
    });

    const result = await softDeleteAbsentGitHubComments(
      tx as never,
      absentInput(),
      (ids) => {
        order.push(`lock:${ids.join(",")}`);
        return Promise.resolve();
      }
    );

    expect(order).toEqual(["lock:9,10", "write"]);
    expect(tx.gitHubCommentProjection.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          commentId: { in: ["comment-1", "comment-2"] },
          githubDeletedAt: null,
          OR: [
            { githubUpdatedAt: null },
            { githubUpdatedAt: { lt: new Date("2026-07-05T12:00:00.000Z") } },
          ],
          comment: { updatedAt: { lt: absentInput().listedAt } },
        },
      })
    );
    expect(result.commentIds).toEqual(["comment-2"]);
    expect(tx.comment.update).toHaveBeenCalledTimes(1);
    expect(tx.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "comment-2" } })
    );
  });

  it("asks only about the threads its deletes touched, never every thread of the pull request", async () => {
    const tx = absentTx([
      { commentId: "comment-1", threadId: "thread-1", githubCommentId: "9" },
      { commentId: "comment-2", threadId: "thread-2", githubCommentId: "10" },
    ]);

    const result = await softDeleteAbsentGitHubComments(
      tx as never,
      absentInput(),
      () => Promise.resolve()
    );

    expect(tx.gitHubCommentThreadProjection.findMany).not.toHaveBeenCalled();
    expect(tx.gitHubCommentProjection.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: { in: ["thread-1", "thread-2"] },
        }),
      })
    );
    expect(result.deletedThreadCount).toBe(2);
  });
});

describe("softDeleteGitHubCommentRowsByRemoteId", () => {
  it("soft-deletes only the affected thread with no remaining live comment, skipping the one that still has one", async () => {
    const tx = {
      gitHubCommentProjection: {
        // First call: the scoped lookup by remote comment id, spanning two
        // threads. Second call: `findThreadIdsWithLiveComments`'s existence
        // probe over those two threads.
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { commentId: "comment-a", threadId: "thread-with-live" },
            { commentId: "comment-b", threadId: "thread-now-empty" },
          ])
          .mockResolvedValueOnce([{ threadId: "thread-with-live" }]),
        update: vi.fn(),
      },
      comment: {
        update: vi.fn(),
      },
      gitHubCommentThreadProjection: {
        update: vi.fn(),
      },
    };

    const deletedAt = new Date("2026-07-05T12:00:00.000Z");
    const result = await softDeleteGitHubCommentRowsByRemoteId(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
      githubCommentId: "remote-comment-1",
      deletedAt,
    });

    expect(result.commentIds).toHaveLength(2);
    expect(result.deletedThreadCount).toBe(1);
    expect(tx.gitHubCommentThreadProjection.update).toHaveBeenCalledTimes(1);
    expect(tx.gitHubCommentThreadProjection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-now-empty" } })
    );
    expect(tx.gitHubCommentThreadProjection.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "thread-with-live" } })
    );
  });

  it("skips the live-comment existence probe entirely when no comment matches the remote id", async () => {
    const tx = {
      gitHubCommentProjection: {
        findMany: vi.fn().mockResolvedValueOnce([]),
        update: vi.fn(),
      },
      comment: {
        update: vi.fn(),
      },
      gitHubCommentThreadProjection: {
        update: vi.fn(),
      },
    };

    const result = await softDeleteGitHubCommentRowsByRemoteId(tx as never, {
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pullRequestDetailId: "pr-1",
      threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
      githubCommentId: "remote-comment-missing",
      deletedAt: new Date("2026-07-05T12:00:00.000Z"),
    });

    expect(result.commentIds).toHaveLength(0);
    expect(result.deletedThreadCount).toBe(0);
    // Only the initial scoped lookup — `findThreadIdsWithLiveComments` bails
    // out on an empty thread-id set before issuing its own query.
    expect(tx.gitHubCommentProjection.findMany).toHaveBeenCalledTimes(1);
    expect(tx.gitHubCommentThreadProjection.update).not.toHaveBeenCalled();
  });
});
