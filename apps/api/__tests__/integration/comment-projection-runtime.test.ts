import { randomUUID } from "node:crypto";
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
  ArtifactSubtype,
  ArtifactType,
  ChecksStatus,
  ExternalCommentProvider,
  GitHubCommentThreadKind,
  GitHubDiffSide,
  GitHubInstallationStatus,
  GitHubLegacyCommentState,
  GitHubPRState,
  LinkType,
  ThreadSource,
  ThreadStatus,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import type { GitHubPullRequestReviewComment } from "@repo/github";
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
import type { AuthContext } from "@/lib/auth/with-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const githubMocks = vi.hoisted(() => ({
  createPullRequestReviewCommentWithUserToken: vi.fn(),
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
    listPullRequestIssueComments: githubMocks.listPullRequestIssueComments,
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
    listPullRequestReviewComments: githubMocks.listPullRequestReviewComments,
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
    listPullRequestReviews: githubMocks.listPullRequestReviews,
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

vi.mock("@/lib/integration-encryption", () => ({
  decryptIntegrationToken: vi.fn().mockResolvedValue("decrypted-user-token"),
}));

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

type ProjectionGraph = {
  organizationId: string;
  projectId: string;
  user: Awaited<ReturnType<typeof createTestUser>>;
  repositoryId: string;
  repositoryFullName: string;
  documentArtifactId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
};

type ProjectedThread = {
  threadId: string;
  rootCommentId: string;
};

describe.skipIf(!hasDatabase)("comment projection runtime integration", () => {
  beforeEach(() => {
    githubMocks.createPullRequestReviewCommentWithUserToken.mockReset();
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
      expect(
        githubMocks.createPullRequestReviewCommentWithUserToken
      ).toHaveBeenCalledWith(
        "decrypted-user-token",
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

/**
 * Seed the minimum real graph needed for GitHub comment projections:
 * organization/user/project, a document artifact, a branch artifact, active
 * installation repository, and current pull request detail.
 */
async function setupProjectionGraph(): Promise<ProjectionGraph> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId, {
    githubUsername: "author",
  });
  const projectId = await createTestProject(organizationId, user.id);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const repositoryFullName = `closedloop/runtime-${suffix}`;
  const prNumber = (Number.parseInt(suffix.slice(0, 6), 16) % 900_000) + 10_000;

  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: `install-${suffix}`,
        accountId: `acct-${suffix}`,
        accountLogin: "closedloop",
        accountType: "Organization",
        senderLogin: "sender",
        senderId: "sender-id",
        status: GitHubInstallationStatus.ACTIVE,
        repositories: {
          create: {
            githubRepoId: `repo-${suffix}`,
            fullName: repositoryFullName,
            name: `runtime-${suffix}`,
            owner: "closedloop",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repository = installation.repositories[0];
  if (!repository) {
    throw new Error("Failed to seed GitHub repository");
  }

  const documentArtifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        name: "FEA-1193 comment projection fixture",
        slug: `FEA-1193-${suffix}`,
        status: "APPROVED",
        assigneeId: user.id,
        createdById: user.id,
        document: {
          create: {
            repositorySnapshot: {
              repositories: [
                {
                  branch: "main",
                  fullName: repository.fullName,
                  position: 0,
                  role: "primary",
                },
              ],
              source: "test",
            },
            versions: {
              create: {
                version: 1,
                content: "Comment projection runtime fixture",
                createdById: user.id,
              },
            },
          },
        },
      },
      select: { id: true },
    })
  );

  const branchName = `fea-1193-comment-projection-${suffix}`;
  const branchArtifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: GitHubPRState.OPEN,
        externalUrl: `https://github.com/${repositoryFullName}/tree/${encodeURIComponent(
          branchName
        )}`,
        createdById: user.id,
        branch: {
          create: {
            repositoryId: repository.id,
            branchName,
            baseBranch: "main",
            baseBranchSource: "test",
            checksStatus: ChecksStatus.PASSING,
            headSha: "projection-head-sha",
            headShaSource: "test",
            headShaObservedAt: new Date("2026-05-19T12:00:00.000Z"),
            fileCacheStatus: "fresh",
            fileCacheHeadSha: "projection-head-sha",
            syncStatus: "fresh",
          },
        },
        pullRequestDetails: {
          create: {
            repositoryId: repository.id,
            githubId: `github-pr-${suffix}`,
            number: prNumber,
            title: "FEA-1193 projection runtime PR",
            htmlUrl: `https://github.com/${repositoryFullName}/pull/${prNumber}`,
            prState: GitHubPRState.OPEN,
            isCurrent: true,
          },
        },
      },
      select: { id: true, pullRequestDetails: { select: { id: true } } },
    })
  );

  const pullRequestDetailId = branchArtifact.pullRequestDetails[0]?.id;
  if (!pullRequestDetailId) {
    throw new Error("Failed to seed current pull request detail");
  }
  await withDb((db) =>
    db.branchDetail.update({
      where: { artifactId: branchArtifact.id },
      data: { currentPullRequestDetailId: pullRequestDetailId },
    })
  );
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId: documentArtifact.id,
        targetId: branchArtifact.id,
        linkType: LinkType.PRODUCES,
      },
    })
  );

  return {
    organizationId,
    projectId,
    user,
    repositoryId: repository.id,
    repositoryFullName,
    documentArtifactId: documentArtifact.id,
    branchArtifactId: branchArtifact.id,
    pullRequestDetailId,
  };
}

/** Create a native document comment thread for generic comment read checks. */
async function createNativeDocumentThread(graph: ProjectionGraph) {
  await withDb((db) =>
    db.commentThread.create({
      data: {
        organizationId: graph.organizationId,
        source: ThreadSource.NATIVE,
        artifactId: graph.documentArtifactId,
        status: ThreadStatus.OPEN,
        createdById: graph.user.id,
        comments: {
          create: {
            authorId: graph.user.id,
            body: commentBody("Native comment"),
            plainText: "Native comment",
          },
        },
      },
    })
  );
}

async function createExternalAuthor(
  graph: ProjectionGraph,
  login: string,
  overrides: {
    avatarUrl?: string | null;
    profileUrl?: string | null;
    lastSeenAt?: Date;
  } = {}
): Promise<{ id: string }> {
  return await withDb((db) =>
    db.externalCommentAuthor.create({
      data: {
        organizationId: graph.organizationId,
        provider: ExternalCommentProvider.GITHUB,
        providerUserId: `github-user-${login}-${randomUUID()}`,
        providerLogin: login,
        normalizedProviderLogin: login.toLowerCase(),
        displayName: login,
        avatarUrl:
          overrides.avatarUrl ?? `https://avatars.example/${login}.png`,
        profileUrl: overrides.profileUrl ?? `https://github.com/${login}`,
        userId: graph.user.id,
        lastSeenAt: overrides.lastSeenAt,
      },
      select: { id: true },
    })
  );
}

async function createHistoricalPullRequestDetail(
  graph: ProjectionGraph
): Promise<string> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const historical = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        branchArtifactId: graph.branchArtifactId,
        repositoryId: graph.repositoryId,
        githubId: `historical-pr-${suffix}`,
        number: (Number.parseInt(suffix.slice(0, 6), 16) % 900_000) + 910_000,
        title: "Historical PR",
        htmlUrl: `https://github.com/${graph.repositoryFullName}/pull/historical-${suffix}`,
        prState: GitHubPRState.CLOSED,
        isCurrent: false,
      },
      select: { id: true },
    })
  );
  return historical.id;
}

async function createMalformedMissingRemoteComment(graph: ProjectionGraph) {
  const thread = await withDb((db) =>
    db.commentThread.create({
      data: {
        organizationId: graph.organizationId,
        source: ThreadSource.GITHUB,
        artifactId: graph.branchArtifactId,
        status: ThreadStatus.OPEN,
        createdById: graph.user.id,
        comments: {
          create: {
            authorId: graph.user.id,
            body: commentBody("Malformed missing remote id"),
            plainText: "Malformed missing remote id",
            externalId: `missing-remote-local-comment-${randomUUID()}`,
          },
        },
      },
      include: { comments: { select: { id: true } } },
    })
  );
  const rootComment = thread.comments[0];
  if (!rootComment) {
    throw new Error("Failed to seed malformed missing-remote comment");
  }

  await withDb((db) =>
    db.gitHubCommentThreadProjection.create({
      data: {
        threadId: thread.id,
        branchArtifactId: graph.branchArtifactId,
        pullRequestDetailId: graph.pullRequestDetailId,
        threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
        reviewThreadId: "missing-remote-thread",
        rootCommentId: "missing-remote-root",
        path: "src/malformed.ts",
        line: 10,
        legacyState: GitHubLegacyCommentState.PENDING,
      },
    })
  );
  await withDb((db) =>
    db.gitHubCommentProjection.create({
      data: {
        commentId: rootComment.id,
        threadId: thread.id,
        githubCommentId: null,
      },
    })
  );
}

/**
 * Create one GitHub-sourced generic thread plus its GitHub-specific
 * projection rows. Optional reply data exercises same-thread parentage.
 */
async function createProjectedGithubThread(
  graph: ProjectionGraph,
  input: {
    rootCommentId: string;
    reviewThreadId: string;
    githubCommentId: string;
    legacyState?: GitHubLegacyCommentState;
    plainText: string;
    replyPlainText?: string;
  }
): Promise<ProjectedThread> {
  const thread = await withDb((db) =>
    db.commentThread.create({
      data: {
        organizationId: graph.organizationId,
        source: ThreadSource.GITHUB,
        artifactId: graph.branchArtifactId,
        status:
          input.legacyState === GitHubLegacyCommentState.ADDRESSED ||
          input.legacyState === GitHubLegacyCommentState.DISMISSED
            ? ThreadStatus.RESOLVED
            : ThreadStatus.OPEN,
        createdById: graph.user.id,
        comments: {
          create: {
            authorId: graph.user.id,
            body: commentBody(input.plainText),
            plainText: input.plainText,
          },
        },
      },
      include: { comments: { select: { id: true } } },
    })
  );
  const rootComment = thread.comments[0];
  if (!rootComment) {
    throw new Error("Failed to seed root GitHub comment");
  }

  await withDb((db) =>
    db.gitHubCommentThreadProjection.create({
      data: {
        threadId: thread.id,
        branchArtifactId: graph.branchArtifactId,
        pullRequestDetailId: graph.pullRequestDetailId,
        threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
        reviewThreadId: input.reviewThreadId,
        rootCommentId: input.rootCommentId,
        reviewId: `${input.reviewThreadId}-review`,
        path: "src/runtime.ts",
        line: 42,
        side: GitHubDiffSide.RIGHT,
        startLine: 40,
        startSide: GitHubDiffSide.RIGHT,
        commitSha: "projection-head-sha",
        htmlUrl: `https://github.com/${graph.repositoryFullName}/pull/1193#discussion_${input.githubCommentId}`,
        resolvable: true,
        legacyState: input.legacyState ?? GitHubLegacyCommentState.PENDING,
        lastSyncedAt: new Date("2026-05-19T12:00:00.000Z"),
      },
    })
  );
  await withDb((db) =>
    db.gitHubCommentProjection.create({
      data: {
        commentId: rootComment.id,
        threadId: thread.id,
        githubCommentId: input.githubCommentId,
        githubHtmlUrl: `https://github.com/${graph.repositoryFullName}/pull/1193#discussion_${input.githubCommentId}`,
        githubUpdatedAt: new Date("2026-05-19T12:00:00.000Z"),
      },
    })
  );

  const replyPlainText = input.replyPlainText;
  if (replyPlainText) {
    const reply = await withDb((db) =>
      db.comment.create({
        data: {
          threadId: thread.id,
          authorId: graph.user.id,
          parentCommentId: rootComment.id,
          body: commentBody(replyPlainText),
          plainText: replyPlainText,
        },
        select: { id: true },
      })
    );
    await withDb((db) =>
      db.gitHubCommentProjection.create({
        data: {
          commentId: reply.id,
          threadId: thread.id,
          githubCommentId: `${input.githubCommentId}-reply`,
          githubInReplyToCommentId: input.githubCommentId,
          githubHtmlUrl: `https://github.com/${graph.repositoryFullName}/pull/1193#discussion_${input.githubCommentId}-reply`,
          githubUpdatedAt: new Date("2026-05-19T12:00:01.000Z"),
        },
      })
    );
  }

  return { threadId: thread.id, rootCommentId: rootComment.id };
}

async function createProjectedGithubIssueComment(
  graph: ProjectionGraph,
  input: {
    githubCommentId: string;
    plainText: string;
  }
): Promise<ProjectedThread> {
  const result = await withDb.tx((tx) =>
    upsertGitHubIssueCommentThread(tx, {
      organizationId: graph.organizationId,
      branchArtifactId: graph.branchArtifactId,
      pullRequestDetailId: graph.pullRequestDetailId,
      htmlUrl: `https://github.com/${graph.repositoryFullName}/pull/1193#issuecomment-${input.githubCommentId}`,
      legacyState: GitHubLegacyCommentState.PENDING,
      comment: {
        githubCommentId: input.githubCommentId,
        githubHtmlUrl: `https://github.com/${graph.repositoryFullName}/pull/1193#issuecomment-${input.githubCommentId}`,
        githubUpdatedAt: new Date("2026-05-19T12:00:00.000Z"),
        bodyMarkdown: input.plainText,
        author: { userId: graph.user.id },
        createdAt: new Date("2026-05-19T12:00:00.000Z"),
      },
    })
  );
  const rootCommentId = result.commentIds[0];
  if (!rootCommentId) {
    throw new Error("Failed to seed issue-comment projection");
  }
  return { threadId: result.threadId, rootCommentId };
}

function findGitHubCommentProjection(githubCommentId: string) {
  return withDb((db) =>
    db.gitHubCommentProjection.findFirst({
      where: { githubCommentId },
      include: { comment: true },
    })
  );
}

function findGitHubCommentProjectionByThread(threadId: string) {
  return withDb((db) =>
    db.gitHubCommentProjection.findFirst({
      where: { threadId },
      include: { comment: true },
    })
  );
}

function findGitHubThreadProjection(threadId: string) {
  return withDb((db) =>
    db.gitHubCommentThreadProjection.findUnique({
      where: { threadId },
    })
  );
}

function findScopedSharedCommentRows(
  githubCommentId: string,
  pullRequestDetailId: string
) {
  return withDb((db) =>
    db.gitHubCommentProjection
      .findMany({
        where: {
          githubCommentId,
          threadProjection: {
            pullRequestDetailId,
          },
        },
        select: {
          threadId: true,
          githubCommentId: true,
          githubDeletedAt: true,
          comment: {
            select: {
              id: true,
              externalId: true,
              plainText: true,
            },
          },
          threadProjection: {
            select: {
              threadKind: true,
            },
          },
        },
      })
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          threadKind: row.threadProjection.threadKind,
        }))
      )
  );
}

function findCommentByExternalId(externalId: string) {
  return withDb((db) =>
    db.comment.findUnique({
      where: { externalId },
      select: {
        id: true,
        threadId: true,
        plainText: true,
        thread: {
          select: {
            organizationId: true,
            artifactId: true,
            githubProjection: {
              select: {
                branchArtifactId: true,
                pullRequestDetailId: true,
                threadKind: true,
              },
            },
          },
        },
      },
    })
  );
}

async function createGitHubUserConnection(graph: ProjectionGraph) {
  await withDb((db) =>
    db.gitHubUserConnection.create({
      data: {
        accessTokenEncrypted: "encrypted-user-token",
        avatarUrl: "https://avatars.example/author.png",
        githubUserId: "42",
        login: "author",
        normalizedLogin: "author",
        organizationId: graph.organizationId,
        profileUrl: "https://github.com/author",
        scopes: ["repo"],
        userId: graph.user.id,
      },
    })
  );
}

async function createBranchFileChange(
  graph: ProjectionGraph,
  input: { path: string; patch: string }
) {
  await withDb((db) =>
    db.branchFileChange.create({
      data: {
        additions: 1,
        branchArtifactId: graph.branchArtifactId,
        changes: 1,
        deletions: 0,
        headSha: "projection-head-sha",
        isBinary: false,
        patch: input.patch,
        patchBytes: Buffer.byteLength(input.patch),
        path: input.path,
        status: "modified",
      },
    })
  );
}

function authContextForGraph(graph: ProjectionGraph): AuthContext {
  return {
    authMethod: "session",
    clerkOrgId: graph.organizationId,
    clerkUserId: graph.user.clerkId,
    user: graph.user,
  };
}

function providerReviewComment(
  overrides: Partial<GitHubPullRequestReviewComment> = {}
): GitHubPullRequestReviewComment {
  const id = overrides.id ?? 501_000;
  return {
    author_association: "OWNER",
    body: overrides.body ?? "Provider body",
    commit_id: overrides.commit_id ?? "projection-head-sha",
    created_at: overrides.created_at ?? "2026-05-20T08:00:00.000Z",
    deleted_at: null,
    html_url:
      overrides.html_url ??
      `https://github.com/closedloop/runtime/pull/1194#discussion_r${id}`,
    id,
    in_reply_to_id: overrides.in_reply_to_id ?? null,
    is_deleted: false,
    is_updated: false,
    line: overrides.line ?? 2,
    node_id: overrides.node_id ?? `review-comment-node-${id}`,
    original_line: overrides.original_line ?? null,
    original_start_line: overrides.original_start_line ?? null,
    path: overrides.path ?? "src/direct-write.ts",
    pull_request_review_id: overrides.pull_request_review_id ?? 7001,
    review_thread_is_resolved:
      overrides.review_thread_is_resolved === undefined
        ? false
        : overrides.review_thread_is_resolved,
    review_thread_node_id:
      overrides.review_thread_node_id ?? "direct-write-review-thread",
    side: overrides.side ?? ApiGitHubDiffSide.Right,
    start_line: overrides.start_line ?? null,
    start_side: overrides.start_side ?? null,
    updated_at: overrides.updated_at ?? "2026-05-20T08:01:00.000Z",
    user: overrides.user ?? {
      avatar_url: "https://avatars.example/author.png",
      id: 42,
      login: "author",
      node_id: "github-user-node-author",
    },
  };
}

/** Minimal rich-text body shape used by persisted comment rows. */
function commentBody(text: string) {
  return {
    content: [{ content: [{ text, type: "text" }], type: "paragraph" }],
    type: "doc",
  };
}
