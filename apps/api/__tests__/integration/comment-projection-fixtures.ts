/**
 * Database fixtures for the comment-projection integration suites.
 *
 * Split out of `comment-projection-runtime.test.ts` (which is grandfathered
 * over the file-size ceiling): these builders seed real rows and assert
 * nothing, so they are a separate responsibility from the tests that use
 * them — and reusable by any sibling suite that needs the same graph.
 */

import { randomUUID } from "node:crypto";
import { GitHubDiffSide as ApiGitHubDiffSide } from "@repo/api/src/types/branch-view";
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
import type { GitHubPullRequestReviewComment } from "@repo/github";
import { upsertGitHubIssueCommentThread } from "@/app/comments/github-projection";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

export type ProjectionGraph = {
  organizationId: string;
  projectId: string;
  user: Awaited<ReturnType<typeof createTestUser>>;
  repositoryId: string;
  repositoryFullName: string;
  documentArtifactId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
};

export type ProjectedThread = {
  threadId: string;
  rootCommentId: string;
};

/**
 * Seed the minimum real graph needed for GitHub comment projections:
 * organization/user/project, a document artifact, a branch artifact, active
 * installation repository, and current pull request detail.
 */
export async function setupProjectionGraph(): Promise<ProjectionGraph> {
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
            organizationId,
            repositoryFullName,
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
            organizationId,
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
export async function createNativeDocumentThread(graph: ProjectionGraph) {
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

export async function createExternalAuthor(
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

export async function createHistoricalPullRequestDetail(
  graph: ProjectionGraph
): Promise<string> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const historical = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: graph.organizationId,
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

export async function createMalformedMissingRemoteComment(
  graph: ProjectionGraph
) {
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
export async function createProjectedGithubThread(
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

export async function createProjectedGithubIssueComment(
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

export async function createGitHubUserConnection(graph: ProjectionGraph) {
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

export async function createBranchFileChange(
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

export function authContextForGraph(graph: ProjectionGraph): AuthContext {
  return {
    authMethod: "session",
    clerkOrgId: graph.organizationId,
    clerkUserId: graph.user.clerkId,
    user: graph.user,
  };
}

export function providerReviewComment(
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
export function commentBody(text: string) {
  return {
    content: [{ content: [{ text, type: "text" }], type: "paragraph" }],
    type: "doc",
  };
}
