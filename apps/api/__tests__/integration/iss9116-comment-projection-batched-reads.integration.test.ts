/**
 * ISS-9116 findings 2 and 3: two reads in the GitHub comment projection asked a
 * set-shaped question one row at a time, next to a batched read of the same
 * scope in the same file.
 *
 * Both sit under the backfill write path's per-PR loop, so their cost
 * multiplied by the pull request count that finding 1 addresses.
 *
 * The assertions are STATEMENT COUNTS, never elapsed time
 * (`scripts/lint/rules/no-timing-assertions.ts`).
 */

import { randomUUID } from "node:crypto";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { GitHubPRState } from "@repo/api/src/types/github";
import { keys } from "@repo/database/keys";
import { describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every import, so the counter is pulled in HERE
// rather than referenced from a top-level binding that is still in its temporal
// dead zone when this factory runs.
vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const { countingWithDb } = await import(
    "@/__tests__/support/prisma-statement-counter"
  );
  return { ...actual, withDb: countingWithDb(actual) };
});

import { ArtifactType, GitHubCommentThreadKind, withDb } from "@repo/database";
import {
  occurrences,
  startCounting,
} from "@/__tests__/support/prisma-statement-counter";
import { upsertGitHubReviewCommentThread } from "@/app/comments/service/github/github-projection";
import { softDeleteGitHubCommentRowsByRemoteId } from "@/app/comments/service/github/github-projection-delete";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPOSITORY = "acme/iss9116-comments";

/**
 * One `comment.findMany` answers the external-id scope check for a whole
 * thread, where the per-id `findUnique` loop cost one statement per comment.
 */
const SCOPE_CHECK_STATEMENTS_PER_UPSERT = 1;

async function seedPullRequestScope() {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const branchArtifactId = randomUUID();
  await withDb((db) =>
    db.artifact.create({
      data: {
        id: branchArtifactId,
        organizationId,
        type: ArtifactType.BRANCH,
        name: "feat/iss9116-comments",
        status: GitHubPRState.Open,
        branch: {
          create: {
            organizationId,
            repositoryFullName: REPOSITORY,
            branchName: "feat/iss9116-comments",
          },
        },
      },
      select: { id: true },
    })
  );
  const pullRequestDetail = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId,
        repositoryFullName: REPOSITORY,
        githubId: `PR_iss9116_comments_${randomUUID()}`,
        number: 1,
        title: "Comment projection scope",
        htmlUrl: `https://github.com/${REPOSITORY}/pull/1`,
        prState: GitHubPRState.Open,
        isCurrent: true,
      },
      select: { id: true },
    })
  );
  return {
    organizationId,
    branchArtifactId,
    pullRequestDetailId: pullRequestDetail.id,
    userId: user.id,
  };
}

function reviewComment(
  scope: {
    organizationId: string;
    branchArtifactId: string;
    pullRequestDetailId: string;
    userId: string;
  },
  reviewThreadId: string,
  githubCommentIds: readonly string[]
) {
  return {
    organizationId: scope.organizationId,
    branchArtifactId: scope.branchArtifactId,
    pullRequestDetailId: scope.pullRequestDetailId,
    reviewThreadId,
    reviewId: null,
    rootCommentId: githubCommentIds[0] as string,
    path: "src/index.ts",
    line: 1,
    side: null,
    startLine: null,
    startSide: null,
    commitSha: "commit-sha",
    htmlUrl: `https://github.com/${REPOSITORY}/pull/1#discussion_${reviewThreadId}`,
    comments: githubCommentIds.map((githubCommentId, index) => ({
      githubCommentId,
      githubInReplyToCommentId: index === 0 ? null : githubCommentIds[0],
      githubHtmlUrl: `https://github.com/${REPOSITORY}/pull/1#c${githubCommentId}`,
      githubUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
      bodyMarkdown: `body ${githubCommentId}`,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      author: { userId: scope.userId, externalAuthorId: null },
    })),
  };
}

describeIfDb("ISS-9116 comment projection batched reads", () => {
  it("checks a whole thread's external ids in one statement", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedPullRequestScope();
      const ids = Array.from({ length: 12 }, (_, index) => `${9000 + index}`);

      const collect = startCounting();
      await withDb((tx) =>
        upsertGitHubReviewCommentThread(
          tx,
          reviewComment(scope, "review-thread-batched", ids)
        )
      );
      const issued = collect();

      expect(occurrences(issued, "comment.findMany")).toBe(
        // The scope check, plus the sibling thread-resolution read that already
        // batched the same id set.
        SCOPE_CHECK_STATEMENTS_PER_UPSERT + 1
      );
      // The retired per-id loop. Twelve comments used to cost twelve of these.
      expect(occurrences(issued, "comment.findUnique")).toBe(0);
    });
  });

  it("rejects the first out-of-scope external id, as the per-id loop did", async () => {
    await autoRollbackTransaction(async () => {
      const first = await seedPullRequestScope();
      const second = await seedPullRequestScope();
      const shared = ["9100", "9101", "9102"];
      await withDb((tx) =>
        upsertGitHubReviewCommentThread(
          tx,
          reviewComment(first, "review-thread-owner", shared)
        )
      );

      await expect(
        withDb((tx) =>
          upsertGitHubReviewCommentThread(
            tx,
            reviewComment(second, "review-thread-thief", shared)
          )
        )
      ).rejects.toMatchObject({
        details: expect.objectContaining({ githubCommentId: shared[0] }),
      });
    });
  });

  it("answers the live-comment question for every affected thread at once", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seedPullRequestScope();
      const sharedRemoteId = "9200";
      const threadCount = 6;
      const threadIds: string[] = [];
      for (let index = 0; index < threadCount; index += 1) {
        const result = await withDb((tx) =>
          upsertGitHubReviewCommentThread(
            tx,
            reviewComment(scope, `review-thread-${index}`, [`${9300 + index}`])
          )
        );
        threadIds.push(result.threadId);
      }
      // `github_comment_projections_thread_github_comment_unique` is scoped to
      // one thread, so the same provider comment id is reachable in several
      // threads at once — which is the only way this loop ever iterates more
      // than once, and therefore the state worth counting statements against.
      for (const [index, threadId] of threadIds.entries()) {
        const comment = await withDb((db) =>
          db.comment.create({
            data: {
              threadId,
              authorId: scope.userId,
              body: { type: "github_markdown", markdown: "shared" },
              bodyFormat: CommentBodyFormat.Markdown,
              plainText: "shared",
              externalId: `github:review_thread:${sharedRemoteId}:${index}`,
            },
            select: { id: true },
          })
        );
        await withDb((db) =>
          db.gitHubCommentProjection.create({
            data: {
              commentId: comment.id,
              threadId,
              githubCommentId: sharedRemoteId,
            },
          })
        );
      }

      const collect = startCounting();
      const result = await withDb((tx) =>
        softDeleteGitHubCommentRowsByRemoteId(tx, {
          organizationId: scope.organizationId,
          branchArtifactId: scope.branchArtifactId,
          pullRequestDetailId: scope.pullRequestDetailId,
          threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
          githubCommentId: sharedRemoteId,
          deletedAt: new Date("2026-09-02T00:00:00.000Z"),
        })
      );
      const issued = collect();

      expect(result.commentIds).toHaveLength(threadCount);
      // One read finds the rows to retire; one answers "does any live comment
      // remain" for all six affected threads. Before the fix the second was one
      // `findFirst` per thread.
      expect(occurrences(issued, "gitHubCommentProjection.findMany")).toBe(2);
      expect(occurrences(issued, "gitHubCommentProjection.findFirst")).toBe(0);
      // Each thread still holds its own root comment, so none is retired.
      expect(result.deletedThreadCount).toBe(0);
    });
  });
});
