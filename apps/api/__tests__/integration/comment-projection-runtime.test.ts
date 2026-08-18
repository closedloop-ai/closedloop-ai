import {
  GitHubDiffSide as ApiGitHubDiffSide,
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  BranchViewCommentActionResultCode,
  BranchViewSyncScope,
  CommentKind,
} from "@repo/api/src/types/branch-view";
import { ThreadSource as ApiThreadSource } from "@repo/api/src/types/comment";
import {
  GitHubCommentThreadKind,
  GitHubDiffSide,
  GitHubLegacyCommentState,
  ThreadSource,
  ThreadStatus,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInlineReviewComment,
  editReviewComment,
} from "@/app/branch-view/[externalLinkId]/comments/direct-write-service";
import {
  fetchUnifiedBranchViewComments,
  getBranchViewData,
  syncCommentsAndReviews,
} from "@/app/branch-view/[externalLinkId]/service";
import {
  GitHubCommentProjectionScopeCollisionError,
  softDeleteGitHubCommentByRemoteId,
  softDeleteGitHubCommentProjection,
  softDeleteScopedGitHubCommentProjection,
  upsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread,
} from "@/app/comments/github-projection";
import { commentsService } from "@/app/comments/service";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import { autoRollbackTransaction, createTestUser } from "../utils/db-helpers";

const githubMocks = vi.hoisted(() => ({
  createPullRequestReviewCommentWithUserToken: vi.fn(),
  getInstallationOctokit: vi.fn(),
  getUserTokenOctokit: vi.fn(),
  installationOctokit: { marker: "installation-octokit" },
  listPullRequestIssueComments: vi.fn(),
  listPullRequestReviewComments: vi.fn(),
  listPullRequestReviews: vi.fn(),
  updatePullRequestReviewCommentWithUserToken: vi.fn(),
}));

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/github")>();
  return {
    ...actual,
    createPullRequestReviewCommentWithUserToken:
      githubMocks.createPullRequestReviewCommentWithUserToken,
    listPullRequestIssueCommentsWithProviderResult: async (
      ...args: unknown[]
    ) => {
      const value = await githubMocks.listPullRequestIssueComments(...args);
      if (value?.status) {
        return value;
      }
      return value === null
        ? { status: actual.GitHubProviderResultStatus.ProviderUnavailable }
        : { status: actual.GitHubProviderResultStatus.Success, value };
    },
    listPullRequestReviewCommentsWithProviderResult: async (
      ...args: unknown[]
    ) => {
      const value = await githubMocks.listPullRequestReviewComments(...args);
      if (value?.status) {
        return value;
      }
      return value === null
        ? { status: actual.GitHubProviderResultStatus.ProviderUnavailable }
        : { status: actual.GitHubProviderResultStatus.Success, value };
    },
    listPullRequestReviewsWithProviderResult: async (...args: unknown[]) => {
      const value = await githubMocks.listPullRequestReviews(...args);
      if (value?.status) {
        return value;
      }
      return value === null
        ? { status: actual.GitHubProviderResultStatus.ProviderUnavailable }
        : { status: actual.GitHubProviderResultStatus.Success, value };
    },
    updatePullRequestReviewCommentWithUserToken:
      githubMocks.updatePullRequestReviewCommentWithUserToken,
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  // Spy wrapper (not a bare vi.fn implementation) so reset passes can never
  // strip the marker client the sync services thread into @repo/github reads.
  getInstallationOctokit: (installationId: string) => {
    githubMocks.getInstallationOctokit(installationId);
    return Promise.resolve(githubMocks.installationOctokit);
  },
}));

vi.mock("@repo/github/user-token-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/github/user-token-auth")>();
  return {
    ...actual,
    // Call-through spy, not a stub: other lanes in this suite (the resolver,
    // the sync client pool) build real clients through this same function, so
    // replacing it would hand them a marker object. Records the client
    // alongside its token so a write assertion can pin the exact instance
    // the identity resolved (PLN-1525 threads a client, not a raw token).
    getUserTokenOctokit: (
      token: string,
      options?: Parameters<typeof actual.getUserTokenOctokit>[1]
    ) => {
      const client = actual.getUserTokenOctokit(token, options);
      githubMocks.getUserTokenOctokit(token, client);
      return client;
    },
  };
});

vi.mock("@/lib/integration-encryption", () => ({
  decryptIntegrationToken: vi.fn().mockResolvedValue("decrypted-user-token"),
}));

import {
  authContextForGraph,
  commentBody,
  createBranchFileChange,
  createExternalAuthor,
  createGitHubUserConnection,
  createHistoricalPullRequestDetail,
  createMalformedMissingRemoteComment,
  createNativeDocumentThread,
  createProjectedGithubIssueComment,
  createProjectedGithubThread,
  providerReviewComment,
  setupProjectionGraph,
} from "./comment-projection-fixtures";
import {
  findCommentByExternalId,
  findGitHubCommentProjection,
  findGitHubCommentProjectionByThread,
  findGitHubThreadProjection,
  findScopedSharedCommentRows,
} from "./comment-projection-query-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("comment projection runtime integration", () => {
  beforeEach(() => {
    githubMocks.createPullRequestReviewCommentWithUserToken.mockReset();
    githubMocks.getInstallationOctokit.mockReset();
    githubMocks.getUserTokenOctokit.mockReset();
    githubMocks.listPullRequestIssueComments.mockReset();
    githubMocks.listPullRequestReviewComments.mockReset();
    githubMocks.listPullRequestReviews.mockReset();
    githubMocks.updatePullRequestReviewCommentWithUserToken.mockReset();
  });

  it("persists GitHub thread/comment projections through Prisma relations and reuses soft-deleted remote thread ids", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();

      const projected = await createProjectedGithubThread(graph, {
        rootCommentId: "github-root-runtime",
        reviewThreadId: "github-review-thread-runtime",
        githubCommentId: "github-comment-runtime",
        plainText: "Root GitHub review comment",
        replyPlainText: "Reply from GitHub",
      });

      const persisted = await withDb((db) =>
        db.gitHubCommentThreadProjection.findUnique({
          where: { threadId: projected.threadId },
          include: {
            branch: true,
            commentProjections: true,
            pullRequestDetail: true,
            thread: {
              include: {
                comments: {
                  include: { githubProjection: true },
                  orderBy: { createdAt: "asc" },
                },
              },
            },
          },
        })
      );

      expect(persisted).toMatchObject({
        branchArtifactId: graph.branchArtifactId,
        pullRequestDetailId: graph.pullRequestDetailId,
        reviewThreadId: "github-review-thread-runtime",
        rootCommentId: "github-root-runtime",
        threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      });
      expect(persisted?.branch.artifactId).toBe(graph.branchArtifactId);
      expect(persisted?.pullRequestDetail.id).toBe(graph.pullRequestDetailId);
      expect(persisted?.thread).toMatchObject({
        artifactId: graph.branchArtifactId,
        organizationId: graph.organizationId,
        source: ThreadSource.GITHUB,
      });
      expect(persisted?.thread.comments).toHaveLength(2);
      expect(persisted?.commentProjections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            githubCommentId: "github-comment-runtime",
            githubInReplyToCommentId: null,
          }),
          expect.objectContaining({
            githubInReplyToCommentId: "github-comment-runtime",
          }),
        ])
      );

      const reusable = await createProjectedGithubThread(graph, {
        rootCommentId: "github-root-reusable",
        reviewThreadId: "github-review-thread-reusable",
        githubCommentId: "github-comment-reusable",
        plainText: "Soft-deleted comment",
      });
      await withDb((db) =>
        db.gitHubCommentThreadProjection.update({
          where: { threadId: reusable.threadId },
          data: { deletedAt: new Date("2026-05-19T12:00:00.000Z") },
        })
      );
      await withDb((db) =>
        db.gitHubCommentProjection.update({
          where: { commentId: reusable.rootCommentId },
          data: { githubDeletedAt: new Date("2026-05-19T12:00:00.000Z") },
        })
      );

      const replacementComment = await withDb((db) =>
        db.comment.create({
          data: {
            threadId: reusable.threadId,
            authorId: graph.user.id,
            body: commentBody("Replacement comment"),
            plainText: "Replacement comment",
          },
          select: { id: true },
        })
      );
      await withDb((db) =>
        db.gitHubCommentProjection.create({
          data: {
            commentId: replacementComment.id,
            threadId: reusable.threadId,
            githubCommentId: "github-comment-reusable",
            githubHtmlUrl:
              "https://github.com/closedloop/runtime/pull/1193#discussion_r2",
            githubUpdatedAt: new Date("2026-05-19T12:01:00.000Z"),
          },
        })
      );

      const replacementThread = await createProjectedGithubThread(graph, {
        rootCommentId: "github-root-reusable",
        reviewThreadId: "github-review-thread-reusable",
        githubCommentId: "github-comment-reusable-new-thread",
        plainText: "Replacement review thread",
      });

      const sameRemoteComments = await withDb((db) =>
        db.gitHubCommentProjection.findMany({
          where: {
            threadId: reusable.threadId,
            githubCommentId: "github-comment-reusable",
          },
          orderBy: { githubDeletedAt: "asc" },
        })
      );
      const reusableThreads = await withDb((db) =>
        db.gitHubCommentThreadProjection.findMany({
          where: {
            pullRequestDetailId: graph.pullRequestDetailId,
            rootCommentId: "github-root-reusable",
          },
          orderBy: { deletedAt: "asc" },
        })
      );

      expect(replacementThread.threadId).not.toBe(reusable.threadId);
      expect(sameRemoteComments).toHaveLength(2);
      expect(
        sameRemoteComments.filter((row) => row.githubDeletedAt === null)
      ).toHaveLength(1);
      expect(reusableThreads).toHaveLength(2);
      expect(
        reusableThreads.filter((row) => row.deletedAt === null)
      ).toHaveLength(1);
    });
  });

  it("keeps GitHub projection metadata out of generic comment service reads for native and branch artifacts", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      await createNativeDocumentThread(graph);
      const projected = await createProjectedGithubThread(graph, {
        rootCommentId: "github-root-generic-read",
        reviewThreadId: "github-review-thread-generic-read",
        githubCommentId: "github-comment-generic-read",
        plainText: "GitHub branch comment",
      });

      const documentThreads = await commentsService.findThreadsByDocument(
        graph.organizationId,
        graph.documentArtifactId
      );
      const branchThreads = await commentsService.findThreadsByDocument(
        graph.organizationId,
        graph.branchArtifactId
      );
      const projection = await withDb((db) =>
        db.gitHubCommentThreadProjection.findUnique({
          where: { threadId: projected.threadId },
          include: { commentProjections: true },
        })
      );

      expect(documentThreads).toMatchObject([
        {
          artifactId: graph.documentArtifactId,
          source: ApiThreadSource.Native,
          comments: [expect.objectContaining({ plainText: "Native comment" })],
        },
      ]);
      expect(branchThreads).toMatchObject([
        {
          artifactId: graph.branchArtifactId,
          source: ApiThreadSource.Github,
          comments: [
            expect.objectContaining({ plainText: "GitHub branch comment" }),
          ],
        },
      ]);
      expect(projection).toMatchObject({
        reviewThreadId: "github-review-thread-generic-read",
        rootCommentId: "github-root-generic-read",
      });
      expect(projection?.commentProjections).toHaveLength(1);

      const serializedThreads = JSON.stringify({
        branchThreads,
        documentThreads,
      });
      expect(serializedThreads).not.toContain("githubProjection");
      expect(serializedThreads).not.toContain("githubCommentId");
      expect(serializedThreads).not.toContain("githubInReplyToCommentId");
      expect(serializedThreads).not.toContain("pullRequestDetailId");
      expect(serializedThreads).not.toContain("reviewThreadId");
      expect(serializedThreads).not.toContain("rootCommentId");
      expect(serializedThreads).not.toContain("lastSyncedAt");
    });
  });

  it("reactivates soft-deleted same-scope GitHub threads and comments during re-projection", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();

      const first = await withDb.tx((tx) =>
        upsertGitHubReviewCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          reviewThreadId: "soft-delete-review-thread",
          rootCommentId: "soft-delete-root",
          path: "src/reactivate.ts",
          line: 9,
          legacyState: GitHubLegacyCommentState.PENDING,
          comments: [
            {
              githubCommentId: "soft-delete-root",
              bodyMarkdown: "Original projected body",
              author: { userId: graph.user.id },
              createdAt: new Date("2026-05-20T08:00:00.000Z"),
            },
          ],
        })
      );
      const deletedAt = new Date("2026-05-20T09:00:00.000Z");
      await withDb.tx(async (tx) => {
        await tx.gitHubCommentThreadProjection.update({
          where: { threadId: first.threadId },
          data: { deletedAt },
        });
        await tx.gitHubCommentProjection.update({
          where: { commentId: first.commentIds[0] },
          data: { githubDeletedAt: deletedAt },
        });
        await tx.comment.update({
          where: { id: first.commentIds[0] },
          data: { deletedAt },
        });
      });

      const second = await withDb.tx((tx) =>
        upsertGitHubReviewCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          reviewThreadId: "soft-delete-review-thread",
          rootCommentId: "soft-delete-root",
          path: "src/reactivate.ts",
          line: 10,
          legacyState: GitHubLegacyCommentState.PENDING,
          comments: [
            {
              githubCommentId: "soft-delete-root",
              bodyMarkdown: "Reactivated projected body",
              author: { userId: graph.user.id },
              createdAt: new Date("2026-05-20T08:00:00.000Z"),
              githubUpdatedAt: new Date("2026-05-20T09:30:00.000Z"),
            },
          ],
        })
      );

      const reactivated = await withDb((db) =>
        db.gitHubCommentProjection.findUnique({
          where: { commentId: first.commentIds[0] },
          include: {
            comment: true,
            threadProjection: true,
          },
        })
      );

      expect(second.threadId).toBe(first.threadId);
      expect(second.commentIds).toEqual(first.commentIds);
      expect(second.createdGithubCommentIds).toEqual([]);
      expect(reactivated).toMatchObject({
        githubDeletedAt: null,
        threadProjection: {
          deletedAt: null,
          line: 10,
        },
        comment: {
          deletedAt: null,
          plainText: "Reactivated projected body",
        },
      });
    });
  });

  it("reads branch-view comments from unified projections", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      await createProjectedGithubThread(graph, {
        rootCommentId: "github-root-hidden-from-branch-view",
        reviewThreadId: "github-review-thread-hidden-from-branch-view",
        githubCommentId: "github-comment-hidden-from-branch-view",
        plainText: "Projection-only comment",
      });

      const prContext = await resolvePrContext(
        graph.branchArtifactId,
        graph.organizationId
      );
      expect(prContext).not.toBeNull();
      if (!prContext) {
        throw new Error(
          "Expected seeded branch artifact to resolve PR context"
        );
      }

      const result = await getBranchViewData(prContext, graph.user);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected branch view data to load");
      }
      expect(result.value.comments).toEqual([
        expect.objectContaining({
          githubCommentId: "github-comment-hidden-from-branch-view",
          body: "Projection-only comment",
        }),
      ]);
    });
  });

  it("maps unified current-PR projections into BranchViewComment without local-id fallback", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      const externalAuthor = await createExternalAuthor(graph, "octocat", {
        lastSeenAt: new Date("2026-05-20T07:00:00.000Z"),
      });
      await createExternalAuthor(graph, "wrong-linked-identity", {
        lastSeenAt: new Date("2026-05-20T09:00:00.000Z"),
      });
      const historicalPrId = await createHistoricalPullRequestDetail(graph);

      await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          htmlUrl:
            "https://github.com/closedloop/runtime/pull/1194#issuecomment-1001",
          legacyState: GitHubLegacyCommentState.PENDING,
          lastSyncedAt: new Date("2026-05-20T08:00:00.000Z"),
          comment: {
            githubCommentId: "1001",
            githubHtmlUrl:
              "https://github.com/closedloop/runtime/pull/1194#issuecomment-1001",
            githubUpdatedAt: new Date("2026-05-20T08:02:00.000Z"),
            bodyMarkdown: "**Issue** body with <script>alert(1)</script>",
            author: {
              userId: graph.user.id,
              externalAuthorId: externalAuthor.id,
            },
            createdAt: new Date("2026-05-20T08:00:00.000Z"),
          },
        })
      );
      await withDb.tx((tx) =>
        upsertGitHubReviewCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          reviewThreadId: "review-thread-current",
          rootCommentId: "review-root-1001",
          reviewId: "review-1",
          path: "src/current.ts",
          line: 7,
          side: GitHubDiffSide.RIGHT,
          startLine: 6,
          startSide: GitHubDiffSide.RIGHT,
          commitSha: "projection-head-sha",
          htmlUrl:
            "https://github.com/closedloop/runtime/pull/1194#discussion_r1001",
          legacyState: GitHubLegacyCommentState.PENDING,
          resolvable: true,
          lastSyncedAt: new Date("2026-05-20T08:00:00.000Z"),
          comments: [
            {
              githubCommentId: "review-1001",
              githubHtmlUrl:
                "https://github.com/closedloop/runtime/pull/1194#discussion_r1001",
              githubUpdatedAt: new Date("2026-05-20T08:02:00.000Z"),
              bodyMarkdown: "Review body excluded from FEA-1196 bridge",
              author: {
                userId: graph.user.id,
                externalAuthorId: externalAuthor.id,
              },
              createdAt: new Date("2026-05-20T08:00:00.000Z"),
            },
          ],
        })
      );
      await createProjectedGithubThread(
        { ...graph, pullRequestDetailId: historicalPrId },
        {
          rootCommentId: "historical-root",
          reviewThreadId: "historical-thread",
          githubCommentId: "historical-comment",
          plainText: "Historical same-branch comment",
        }
      );
      await createMalformedMissingRemoteComment(graph);

      const prContext = await resolvePrContext(
        graph.branchArtifactId,
        graph.organizationId
      );
      expect(prContext).not.toBeNull();
      if (!prContext) {
        throw new Error(
          "Expected seeded branch artifact to resolve PR context"
        );
      }

      const comments = await fetchUnifiedBranchViewComments(
        prContext,
        graph.user
      );
      const persistedComments = await withDb((db) =>
        db.gitHubCommentProjection.findMany({
          where: {
            githubCommentId: { in: ["1001", "review-1001"] },
            threadProjection: {
              pullRequestDetailId: graph.pullRequestDetailId,
            },
          },
          select: {
            githubCommentId: true,
            comment: {
              select: {
                id: true,
                editedAt: true,
                parentCommentId: true,
              },
            },
          },
        })
      );
      const persistedByRemoteId = new Map(
        persistedComments.map((comment) => [
          comment.githubCommentId,
          comment.comment,
        ])
      );

      expect(comments).toHaveLength(2);
      const commentsById = new Map(
        comments.map((comment) => [comment.id, comment])
      );
      expect(commentsById.get("1001")).toMatchObject({
        id: "1001",
        githubCommentId: "1001",
        threadId: expect.any(String),
        commentId: expect.any(String),
        source: "github",
        author: "octocat",
        authorAvatar: "https://avatars.example/octocat.png",
        authorProfileUrl: "https://github.com/octocat",
        authorKind: "user",
        body: "**Issue** body with <script>alert(1)</script>",
        path: null,
        line: null,
        state: "PENDING",
        reviewId: null,
        htmlUrl:
          "https://github.com/closedloop/runtime/pull/1194#issuecomment-1001",
        inReplyToId: null,
        kind: "issue_comment",
        resolvable: false,
        resolved: false,
        canReply: false,
        canEdit: false,
        canDelete: false,
        canResolve: false,
        canUnresolve: false,
      });
      expect(commentsById.get("review-1001")).toMatchObject({
        id: "review-1001",
        githubCommentId: "review-1001",
        threadId: expect.any(String),
        commentId: expect.any(String),
        source: "github",
        author: "octocat",
        authorAvatar: "https://avatars.example/octocat.png",
        authorProfileUrl: "https://github.com/octocat",
        authorKind: "user",
        body: "Review body excluded from FEA-1196 bridge",
        path: "src/current.ts",
        line: 7,
        state: "PENDING",
        reviewId: "review-1",
        htmlUrl:
          "https://github.com/closedloop/runtime/pull/1194#discussion_r1001",
        inReplyToId: null,
        kind: "review_comment",
        resolvable: true,
        resolved: false,
        canReply: false,
        canEdit: false,
        canDelete: false,
        canResolve: false,
        canUnresolve: false,
      });
      expect(persistedByRemoteId.get("1001")?.editedAt).toEqual(
        new Date("2026-05-20T08:02:00.000Z")
      );
      expect(persistedByRemoteId.get("review-1001")?.editedAt).toEqual(
        new Date("2026-05-20T08:02:00.000Z")
      );
      const serialized = JSON.stringify(comments);
      expect(serialized).not.toContain("plainText");
      expect(serialized).not.toContain("historical-comment");
      expect(serialized).not.toContain("missing-remote-local-comment");
      expect(serialized).not.toContain("wrong-linked-identity");
    });
  });

  it("projects direct-write provider success into unified branch-view comments", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      await createGitHubUserConnection(graph);
      await createBranchFileChange(graph, {
        path: "src/direct-write.ts",
        patch: `@@ -1,2 +1,3 @@
 export const before = true;
+export const directWrite = true;
 export const after = true;`,
      });
      const providerComment = providerReviewComment({
        body: "Direct-write projected body",
        html_url:
          "https://github.com/closedloop/runtime/pull/1194#discussion_r501001",
        id: 501_001,
        path: "src/direct-write.ts",
        review_thread_node_id: "direct-write-review-thread",
      });
      githubMocks.createPullRequestReviewCommentWithUserToken.mockResolvedValue(
        providerComment
      );
      const prContext = await resolvePrContext(
        graph.branchArtifactId,
        graph.organizationId
      );
      expect(prContext).not.toBeNull();
      if (!prContext) {
        throw new Error(
          "Expected seeded branch artifact to resolve PR context"
        );
      }

      const result = await createInlineReviewComment({
        auth: authContextForGraph(graph),
        ctx: prContext,
        request: {
          body: "Direct-write projected body",
          expectedHeadSha: "projection-head-sha",
          line: 2,
          path: "src/direct-write.ts",
          side: ApiGitHubDiffSide.Right,
        },
        user: graph.user,
      });
      const projection = await withDb((db) =>
        db.gitHubCommentProjection.findFirst({
          where: {
            githubCommentId: "501001",
            threadProjection: {
              branchArtifactId: graph.branchArtifactId,
              pullRequestDetailId: graph.pullRequestDetailId,
            },
          },
          include: {
            comment: true,
            threadProjection: true,
          },
        })
      );
      const branchViewComments = await fetchUnifiedBranchViewComments(
        prContext,
        graph.user
      );

      expect(result).toMatchObject({
        success: true,
        comment: {
          githubCommentId: "501001",
          body: "Direct-write projected body",
          path: "src/direct-write.ts",
          line: 2,
          reviewId: "7001",
        },
      });
      // The write authenticates as the user: the decrypted token builds a
      // bounded client, and that exact client — not the installation client —
      // is what the writer receives. Matched by identity rather than by call
      // order, since reads later in this test build user clients too.
      expect(githubMocks.getUserTokenOctokit).toHaveBeenCalledWith(
        "decrypted-user-token",
        expect.anything()
      );
      const userOctokits = githubMocks.getUserTokenOctokit.mock.calls.map(
        ([, client]) => client
      );
      const [writeOctokit] =
        githubMocks.createPullRequestReviewCommentWithUserToken.mock.calls[0] ??
        [];
      expect(userOctokits).toContain(writeOctokit);
      expect(writeOctokit).not.toBe(githubMocks.installationOctokit);
      expect(
        githubMocks.createPullRequestReviewCommentWithUserToken
      ).toHaveBeenCalledWith(
        writeOctokit,
        "closedloop",
        expect.any(String),
        expect.any(Number),
        {
          body: "Direct-write projected body",
          commitId: "projection-head-sha",
          line: 2,
          path: "src/direct-write.ts",
          side: ApiGitHubDiffSide.Right,
          startLine: undefined,
          startSide: undefined,
        }
      );
      expect(projection).toMatchObject({
        githubCommentId: "501001",
        githubHtmlUrl:
          "https://github.com/closedloop/runtime/pull/1194#discussion_r501001",
        threadProjection: {
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          reviewThreadId: "direct-write-review-thread",
          rootCommentId: "501001",
        },
      });
      expect(projection?.comment).toMatchObject({
        plainText: "Direct-write projected body",
      });
      expect(branchViewComments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            githubCommentId: "501001",
            body: "Direct-write projected body",
          }),
        ])
      );
    });
  });

  it("preserves existing review thread state when sync payload omits resolution metadata", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      await createGitHubUserConnection(graph);
      await createProjectedGithubThread(graph, {
        githubCommentId: "501010",
        legacyState: GitHubLegacyCommentState.ADDRESSED,
        plainText: "Previously resolved GitHub review comment",
        reviewThreadId: "preserve-review-thread",
        rootCommentId: "501010",
      });
      githubMocks.listPullRequestReviewComments.mockResolvedValue([
        providerReviewComment({
          body: "Provider body without resolved metadata",
          id: 501_010,
          review_thread_is_resolved: null,
          review_thread_node_id: "preserve-review-thread",
        }),
      ]);
      githubMocks.listPullRequestIssueComments.mockResolvedValue([]);
      githubMocks.listPullRequestReviews.mockResolvedValue([]);
      const prContext = await resolvePrContext(
        graph.branchArtifactId,
        graph.organizationId
      );
      expect(prContext).not.toBeNull();
      if (!prContext) {
        throw new Error(
          "Expected seeded branch artifact to resolve PR context"
        );
      }

      await expect(syncCommentsAndReviews(prContext)).resolves.toEqual({
        error: null,
        scope: BranchViewSyncScope.Comments,
        synced: true,
      });
      const projection = await withDb((db) =>
        db.gitHubCommentThreadProjection.findFirst({
          where: {
            branchArtifactId: graph.branchArtifactId,
            pullRequestDetailId: graph.pullRequestDetailId,
            reviewThreadId: "preserve-review-thread",
          },
          include: { thread: true },
        })
      );

      expect(projection).toMatchObject({
        legacyState: GitHubLegacyCommentState.ADDRESSED,
        thread: { status: ThreadStatus.RESOLVED },
      });
    });
  });

  it("returns sync recovery when direct-write provider success cannot be projected", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      await createGitHubUserConnection(graph);
      await createBranchFileChange(graph, {
        path: "src/direct-write-failure.ts",
        patch: `@@ -1,2 +1,3 @@
 export const before = true;
+export const directWriteFailure = true;
 export const after = true;`,
      });
      githubMocks.createPullRequestReviewCommentWithUserToken.mockResolvedValue(
        providerReviewComment({
          created_at: "not-a-date",
          id: 501_002,
          path: "src/direct-write-failure.ts",
          review_thread_node_id: "direct-write-review-thread-failure",
        })
      );
      const prContext = await resolvePrContext(
        graph.branchArtifactId,
        graph.organizationId
      );
      expect(prContext).not.toBeNull();
      if (!prContext) {
        throw new Error(
          "Expected seeded branch artifact to resolve PR context"
        );
      }

      const result = await createInlineReviewComment({
        auth: authContextForGraph(graph),
        ctx: prContext,
        request: {
          body: "Projection should fail after provider success",
          expectedHeadSha: "projection-head-sha",
          line: 2,
          path: "src/direct-write-failure.ts",
          side: ApiGitHubDiffSide.Right,
        },
        user: graph.user,
      });
      const projection = await withDb((db) =>
        db.gitHubCommentProjection.findFirst({
          where: { githubCommentId: "501002" },
        })
      );

      expect(
        githubMocks.createPullRequestReviewCommentWithUserToken
      ).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        action: BranchViewCommentAction.CreateInline,
        code: BranchViewCommentActionResultCode.GithubProjectionFailed,
        github: {
          commentId: "501002",
          reviewThreadId: "direct-write-review-thread-failure",
        },
        message:
          "GitHub write succeeded but local branch-view projection failed",
        recovery: BranchViewCommentActionRecovery.BranchViewSync,
        success: false,
      });
      expect(projection).toBeNull();
    });
  });

  it("uses exact external authors before linked-user fallback and never exposes shadow user placeholders", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      const shadowUser = await createTestUser(graph.organizationId, {
        firstName: "Shadow",
        lastName: "Placeholder",
        avatarUrl: "https://avatars.example/shadow-placeholder.png",
        githubUsername: null,
      });
      const botAuthor = await createExternalAuthor(graph, "dependabot[bot]", {
        avatarUrl: "https://avatars.example/dependabot.png",
        profileUrl: "https://github.com/apps/dependabot",
      });
      await createExternalAuthor(graph, "newer-linked-author", {
        lastSeenAt: new Date("2026-05-20T10:00:00.000Z"),
      });

      await withDb.tx(async (tx) => {
        await upsertGitHubIssueCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          legacyState: GitHubLegacyCommentState.PENDING,
          comment: {
            githubCommentId: "author-display-root",
            githubHtmlUrl:
              "https://github.com/closedloop/runtime/pull/1194#issuecomment-author-root",
            bodyMarkdown: "Bot-authored root",
            author: {
              userId: graph.user.id,
              externalAuthorId: botAuthor.id,
            },
            createdAt: new Date("2026-05-20T08:00:00.000Z"),
          },
        });
        await upsertGitHubIssueCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          legacyState: GitHubLegacyCommentState.PENDING,
          comment: {
            githubCommentId: "linked-user-fallback",
            githubHtmlUrl:
              "https://github.com/closedloop/runtime/pull/1194#issuecomment-linked",
            bodyMarkdown: "Linked user fallback",
            author: {
              userId: graph.user.id,
              externalAuthorId: null,
            },
            createdAt: new Date("2026-05-20T08:01:00.000Z"),
          },
        });
        await upsertGitHubIssueCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          legacyState: GitHubLegacyCommentState.PENDING,
          comment: {
            githubCommentId: "shadow-user-fallback",
            githubHtmlUrl:
              "https://github.com/closedloop/runtime/pull/1194#issuecomment-shadow",
            bodyMarkdown: "Unlinked user fallback",
            author: {
              userId: shadowUser.id,
              externalAuthorId: null,
            },
            createdAt: new Date("2026-05-20T08:02:00.000Z"),
          },
        });
      });

      const prContext = await resolvePrContext(
        graph.branchArtifactId,
        graph.organizationId
      );
      expect(prContext).not.toBeNull();
      if (!prContext) {
        throw new Error(
          "Expected seeded branch artifact to resolve PR context"
        );
      }

      const comments = await fetchUnifiedBranchViewComments(
        prContext,
        graph.user
      );
      const byRemoteId = new Map(
        comments.map((comment) => [comment.githubCommentId, comment])
      );

      expect(byRemoteId.get("author-display-root")).toMatchObject({
        author: "dependabot[bot]",
        authorAvatar: "https://avatars.example/dependabot.png",
        authorProfileUrl: "https://github.com/apps/dependabot",
        authorKind: "bot",
      });
      expect(byRemoteId.get("linked-user-fallback")).toMatchObject({
        author: "author",
        authorAvatar: null,
        authorProfileUrl: "https://github.com/author",
        authorKind: "user",
      });
      expect(byRemoteId.get("shadow-user-fallback")).toMatchObject({
        author: "unknown-github-user",
        authorAvatar: null,
        authorProfileUrl: null,
        authorKind: "user",
      });
      const serialized = JSON.stringify(comments);
      expect(serialized).not.toContain("newer-linked-author");
      expect(serialized).not.toContain("Shadow");
      expect(serialized).not.toContain("Placeholder");
      expect(serialized).not.toContain("shadow-placeholder");
    });
  });

  it("rejects PATCH edits for locally deleted unified comments without reviving projection state", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      await createGitHubUserConnection(graph);
      const projected = await createProjectedGithubThread(graph, {
        rootCommentId: "deleted-edit-root",
        reviewThreadId: "deleted-edit-thread",
        githubCommentId: "deleted-edit-comment",
        plainText: "Deleted comment should not be edited",
      });
      const deletedAt = new Date("2026-05-21T12:00:00.000Z");
      await withDb.tx(async (tx) => {
        await tx.gitHubCommentProjection.update({
          where: { commentId: projected.rootCommentId },
          data: { githubDeletedAt: deletedAt },
        });
        await tx.comment.update({
          where: { id: projected.rootCommentId },
          data: { deletedAt },
        });
      });

      const prContext = await resolvePrContext(
        graph.branchArtifactId,
        graph.organizationId
      );
      expect(prContext).not.toBeNull();
      if (!prContext) {
        throw new Error(
          "Expected seeded branch artifact to resolve PR context"
        );
      }

      const result = await editReviewComment({
        auth: authContextForGraph(graph),
        body: "Edited body must not be projected",
        commentId: projected.rootCommentId,
        ctx: prContext,
        user: graph.user,
      });
      const projection = await withDb((db) =>
        db.gitHubCommentProjection.findUnique({
          where: { commentId: projected.rootCommentId },
          include: { comment: true },
        })
      );

      expect(result).toEqual({
        action: BranchViewCommentAction.Edit,
        code: BranchViewCommentActionResultCode.CommentNotFound,
        message: "Comment not found",
        success: false,
      });
      expect(
        githubMocks.updatePullRequestReviewCommentWithUserToken
      ).not.toHaveBeenCalled();
      expect(projection?.githubDeletedAt).toEqual(deletedAt);
      expect(projection?.comment.deletedAt).toEqual(deletedAt);
      expect(projection?.comment.plainText).toBe(
        "Deleted comment should not be edited"
      );
    });
  });

  it("soft-deletes stale unified GitHub rows only in the current PR scope", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      const historicalPrId = await createHistoricalPullRequestDetail(graph);

      await createProjectedGithubThread(graph, {
        rootCommentId: "live-root",
        reviewThreadId: "live-thread",
        githubCommentId: "live-comment",
        plainText: "Live current comment",
      });
      const staleCurrent = await createProjectedGithubThread(graph, {
        rootCommentId: "stale-root",
        reviewThreadId: "stale-thread",
        githubCommentId: "stale-comment",
        plainText: "Stale current comment",
      });
      const historical = await createProjectedGithubThread(
        { ...graph, pullRequestDetailId: historicalPrId },
        {
          rootCommentId: "historical-stale-root",
          reviewThreadId: "historical-stale-thread",
          githubCommentId: "historical-stale-comment",
          plainText: "Historical stale comment",
        }
      );

      const deletedAt = new Date("2026-05-20T08:05:00.000Z");
      const result = await withDb.tx((tx) =>
        softDeleteGitHubCommentProjection(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
          liveGithubCommentIds: new Set(["live-comment"]),
          deletedAt,
        })
      );

      const [currentStaleProjection, currentStaleThread, historicalProjection] =
        await Promise.all([
          withDb((db) =>
            db.gitHubCommentProjection.findFirst({
              where: { githubCommentId: "stale-comment" },
              include: { comment: true },
            })
          ),
          withDb((db) =>
            db.gitHubCommentThreadProjection.findUnique({
              where: { threadId: staleCurrent.threadId },
            })
          ),
          withDb((db) =>
            db.gitHubCommentProjection.findFirst({
              where: { githubCommentId: "historical-stale-comment" },
            })
          ),
        ]);
      const historicalThread = await withDb((db) =>
        db.gitHubCommentThreadProjection.findUnique({
          where: { threadId: historical.threadId },
        })
      );
      expect(result).toEqual({ comments: 1, threads: 1 });
      expect(currentStaleProjection?.githubDeletedAt).toEqual(deletedAt);
      expect(currentStaleProjection?.comment.deletedAt).toEqual(deletedAt);
      expect(currentStaleThread?.deletedAt).toEqual(deletedAt);
      expect(historicalProjection?.githubDeletedAt).toBeNull();
      expect(historicalThread?.deletedAt).toBeNull();
    });
  });

  it("stale-cleans issue and review projections independently when raw ids overlap", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      const sharedGithubCommentId = "shared-stale-cleanup-comment-id";
      const issue = await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          legacyState: GitHubLegacyCommentState.PENDING,
          comment: {
            githubCommentId: sharedGithubCommentId,
            bodyMarkdown: "Issue stale cleanup body",
            author: { userId: graph.user.id },
            createdAt: new Date("2026-05-23T09:00:00.000Z"),
          },
        })
      );
      const review = await withDb.tx((tx) =>
        upsertGitHubReviewCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          reviewThreadId: "shared-stale-cleanup-review-thread",
          rootCommentId: sharedGithubCommentId,
          path: "src/stale-cleanup.ts",
          line: 9,
          side: GitHubDiffSide.RIGHT,
          legacyState: GitHubLegacyCommentState.PENDING,
          comments: [
            {
              githubCommentId: sharedGithubCommentId,
              bodyMarkdown: "Review stale cleanup body",
              author: { userId: graph.user.id },
              createdAt: new Date("2026-05-23T09:01:00.000Z"),
            },
          ],
        })
      );

      const issueDeletedAt = new Date("2026-05-23T09:05:00.000Z");
      const issueCleanup = await withDb.tx((tx) =>
        softDeleteGitHubCommentProjection(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
          liveGithubCommentIds: new Set(),
          deletedAt: issueDeletedAt,
        })
      );

      const [issueAfterIssueCleanup, reviewAfterIssueCleanup] =
        await Promise.all([
          findGitHubCommentProjectionByThread(issue.threadId),
          findGitHubCommentProjectionByThread(review.threadId),
        ]);

      expect(issueCleanup).toEqual({ comments: 1, threads: 1 });
      expect(issueAfterIssueCleanup?.githubDeletedAt).toEqual(issueDeletedAt);
      expect(reviewAfterIssueCleanup?.githubDeletedAt).toBeNull();

      const reviewDeletedAt = new Date("2026-05-23T09:10:00.000Z");
      const reviewCleanup = await withDb.tx((tx) =>
        softDeleteGitHubCommentProjection(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
          liveGithubCommentIds: new Set(),
          deletedAt: reviewDeletedAt,
        })
      );
      const [issueAfterReviewCleanup, reviewAfterReviewCleanup] =
        await Promise.all([
          findGitHubCommentProjectionByThread(issue.threadId),
          findGitHubCommentProjectionByThread(review.threadId),
        ]);

      expect(reviewCleanup).toEqual({ comments: 1, threads: 1 });
      expect(issueAfterReviewCleanup?.githubDeletedAt).toEqual(issueDeletedAt);
      expect(reviewAfterReviewCleanup?.githubDeletedAt).toEqual(
        reviewDeletedAt
      );
    });
  });

  it("soft-deletes only the requested scoped issue-comment projection", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      const first = await createProjectedGithubIssueComment(graph, {
        githubCommentId: "scoped-comment-1",
        plainText: "Delete this comment",
      });
      const second = await createProjectedGithubIssueComment(graph, {
        githubCommentId: "scoped-comment-2",
        plainText: "Keep this comment",
      });

      const deletedAt = new Date("2026-05-20T08:10:00.000Z");
      const result = await withDb.tx((tx) =>
        softDeleteScopedGitHubCommentProjection(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          githubCommentId: "scoped-comment-1",
          deletedAt,
        })
      );

      const [
        deletedProjection,
        retainedProjection,
        deletedThread,
        retainedThread,
      ] = await Promise.all([
        findGitHubCommentProjection("scoped-comment-1"),
        findGitHubCommentProjection("scoped-comment-2"),
        findGitHubThreadProjection(first.threadId),
        findGitHubThreadProjection(second.threadId),
      ]);

      expect(result).toEqual({ comments: 1, threads: 1 });
      expect(deletedProjection?.githubDeletedAt).toEqual(deletedAt);
      expect(deletedProjection?.comment.deletedAt).toEqual(deletedAt);
      expect(deletedThread?.deletedAt).toEqual(deletedAt);
      expect(retainedProjection?.githubDeletedAt).toBeNull();
      expect(retainedProjection?.comment.deletedAt).toBeNull();
      expect(retainedThread?.deletedAt).toBeNull();
    });
  });

  it("does not delete review-thread projections with the same GitHub comment id", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      const issue = await createProjectedGithubIssueComment(graph, {
        githubCommentId: "shared-comment-id",
        plainText: "Delete the issue comment",
      });
      const review = await createProjectedGithubThread(graph, {
        rootCommentId: "shared-review-root",
        reviewThreadId: "shared-review-thread",
        githubCommentId: "shared-comment-id",
        plainText: "Keep the review comment",
      });

      const deletedAt = new Date("2026-05-20T08:15:00.000Z");
      const result = await withDb.tx((tx) =>
        softDeleteScopedGitHubCommentProjection(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          githubCommentId: "shared-comment-id",
          deletedAt,
        })
      );

      const [issueProjection, reviewProjection, issueThread, reviewThread] =
        await Promise.all([
          findGitHubCommentProjectionByThread(issue.threadId),
          findGitHubCommentProjectionByThread(review.threadId),
          findGitHubThreadProjection(issue.threadId),
          findGitHubThreadProjection(review.threadId),
        ]);

      expect(result).toEqual({ comments: 1, threads: 1 });
      expect(issueProjection?.githubDeletedAt).toEqual(deletedAt);
      expect(issueProjection?.comment.deletedAt).toEqual(deletedAt);
      expect(issueThread?.deletedAt).toEqual(deletedAt);
      expect(reviewProjection?.githubDeletedAt).toBeNull();
      expect(reviewProjection?.comment.deletedAt).toBeNull();
      expect(reviewThread?.deletedAt).toBeNull();
    });
  });

  it("keeps same-raw-id issue and review projection writers isolated by source kind", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      const sharedGithubCommentId = "shared-writer-comment-id";

      const issue = await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          htmlUrl: `https://github.com/${graph.repositoryFullName}/pull/1194#issuecomment-${sharedGithubCommentId}`,
          legacyState: GitHubLegacyCommentState.PENDING,
          comment: {
            githubCommentId: sharedGithubCommentId,
            githubHtmlUrl: `https://github.com/${graph.repositoryFullName}/pull/1194#issuecomment-${sharedGithubCommentId}`,
            bodyMarkdown: "Issue writer original body",
            author: { userId: graph.user.id },
            createdAt: new Date("2026-05-22T08:00:00.000Z"),
          },
        })
      );
      const review = await withDb.tx((tx) =>
        upsertGitHubReviewCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          reviewThreadId: "shared-writer-review-thread",
          rootCommentId: sharedGithubCommentId,
          path: "src/shared-writer.ts",
          line: 12,
          side: GitHubDiffSide.RIGHT,
          legacyState: GitHubLegacyCommentState.PENDING,
          comments: [
            {
              githubCommentId: sharedGithubCommentId,
              githubHtmlUrl: `https://github.com/${graph.repositoryFullName}/pull/1194#discussion_${sharedGithubCommentId}`,
              bodyMarkdown: "Review writer original body",
              author: { userId: graph.user.id },
              createdAt: new Date("2026-05-22T08:01:00.000Z"),
            },
          ],
        })
      );

      const initial = await findScopedSharedCommentRows(
        sharedGithubCommentId,
        graph.pullRequestDetailId
      );

      expect(initial).toHaveLength(2);
      expect(new Set(initial.map((row) => row.comment.id)).size).toBe(2);
      expect(new Set(initial.map((row) => row.threadId)).size).toBe(2);
      expect(initial.map((row) => row.threadId)).toEqual(
        expect.arrayContaining([issue.threadId, review.threadId])
      );
      expect(initial).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            githubCommentId: sharedGithubCommentId,
            threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
            comment: expect.objectContaining({
              externalId: `github:${GitHubCommentThreadKind.ISSUE_COMMENT}:comment:${sharedGithubCommentId}`,
              plainText: "Issue writer original body",
            }),
          }),
          expect.objectContaining({
            githubCommentId: sharedGithubCommentId,
            threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
            comment: expect.objectContaining({
              externalId: `github:${GitHubCommentThreadKind.REVIEW_THREAD}:comment:${sharedGithubCommentId}`,
              plainText: "Review writer original body",
            }),
          }),
        ])
      );
      const prContext = await resolvePrContext(
        graph.branchArtifactId,
        graph.organizationId
      );
      expect(prContext).not.toBeNull();
      if (!prContext) {
        throw new Error(
          "Expected seeded branch artifact to resolve PR context"
        );
      }
      const readComments = await fetchUnifiedBranchViewComments(
        prContext,
        graph.user
      );
      const sharedReadComments = readComments.filter(
        (comment) => comment.githubCommentId === sharedGithubCommentId
      );

      expect(sharedReadComments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "Issue writer original body",
            kind: CommentKind.IssueComment,
          }),
          expect.objectContaining({
            body: "Review writer original body",
            kind: CommentKind.ReviewComment,
          }),
        ])
      );

      await withDb.tx((tx) =>
        upsertGitHubIssueCommentThread(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          legacyState: GitHubLegacyCommentState.PENDING,
          comment: {
            githubCommentId: sharedGithubCommentId,
            bodyMarkdown: "Issue writer updated body",
            author: { userId: graph.user.id },
            createdAt: new Date("2026-05-22T08:00:00.000Z"),
            githubUpdatedAt: new Date("2026-05-22T08:05:00.000Z"),
          },
        })
      );

      const afterIssueUpdate = await findScopedSharedCommentRows(
        sharedGithubCommentId,
        graph.pullRequestDetailId
      );

      expect(afterIssueUpdate).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
            comment: expect.objectContaining({
              plainText: "Issue writer updated body",
            }),
          }),
          expect.objectContaining({
            threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
            comment: expect.objectContaining({
              plainText: "Review writer original body",
            }),
          }),
        ])
      );

      const issueDeletedAt = new Date("2026-05-22T08:10:00.000Z");
      await withDb.tx((tx) =>
        softDeleteScopedGitHubCommentProjection(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          githubCommentId: sharedGithubCommentId,
          deletedAt: issueDeletedAt,
        })
      );

      const afterIssueDelete = await findScopedSharedCommentRows(
        sharedGithubCommentId,
        graph.pullRequestDetailId
      );

      expect(afterIssueDelete).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            githubDeletedAt: issueDeletedAt,
            threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
          }),
          expect.objectContaining({
            githubDeletedAt: null,
            threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
          }),
        ])
      );

      const reviewDeletedAt = new Date("2026-05-22T08:15:00.000Z");
      await withDb.tx((tx) =>
        softDeleteGitHubCommentByRemoteId(tx, {
          organizationId: graph.organizationId,
          branchArtifactId: graph.branchArtifactId,
          pullRequestDetailId: graph.pullRequestDetailId,
          githubCommentId: sharedGithubCommentId,
          deletedAt: reviewDeletedAt,
          threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
        })
      );

      const afterReviewDelete = await findScopedSharedCommentRows(
        sharedGithubCommentId,
        graph.pullRequestDetailId
      );

      expect(afterReviewDelete).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            githubDeletedAt: issueDeletedAt,
            threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
          }),
          expect.objectContaining({
            githubDeletedAt: reviewDeletedAt,
            threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
          }),
        ])
      );
    });
  });

  it("refuses foreign issue-comment external-id collisions without moving rows", async () => {
    await autoRollbackTransaction(async () => {
      const graph = await setupProjectionGraph();
      const foreignGraph = await setupProjectionGraph();
      await createProjectedGithubIssueComment(foreignGraph, {
        githubCommentId: "foreign-collision",
        plainText: "Foreign projected comment",
      });
      const before = await findCommentByExternalId(
        "github:ISSUE_COMMENT:comment:foreign-collision"
      );

      await expect(
        withDb.tx((tx) =>
          upsertGitHubIssueCommentThread(tx, {
            organizationId: graph.organizationId,
            branchArtifactId: graph.branchArtifactId,
            pullRequestDetailId: graph.pullRequestDetailId,
            comment: {
              githubCommentId: "foreign-collision",
              bodyMarkdown: "Should not move the foreign row",
              author: { userId: graph.user.id },
              createdAt: new Date("2026-05-20T08:20:00.000Z"),
            },
          })
        )
      ).rejects.toThrow(GitHubCommentProjectionScopeCollisionError);

      const after = await findCommentByExternalId(
        "github:ISSUE_COMMENT:comment:foreign-collision"
      );
      const localProjection = await withDb((db) =>
        db.gitHubCommentProjection.findFirst({
          where: {
            githubCommentId: "foreign-collision",
            threadProjection: {
              branchArtifactId: graph.branchArtifactId,
              pullRequestDetailId: graph.pullRequestDetailId,
            },
          },
        })
      );

      expect(after).toEqual(before);
      expect(localProjection).toBeNull();
    });
  });
});
