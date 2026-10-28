import { randomUUID } from "node:crypto";
import { BranchStatus } from "@repo/api/src/types/branch";
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import { ArtifactType, GitHubDiffSide, withDb } from "@repo/database";
import type {
  GitHubPullRequestIssueComment,
  GitHubPullRequestReviewComment,
} from "@repo/github";
import type { GitHubPullRequestReviewWithAuthor } from "@repo/github/pull-request-comment-lists";
import { createTestUser } from "@/__tests__/utils/db-helpers";
import {
  type ApplyExternalInput,
  type GitHubExternalComment,
  type GitHubExternalEvent,
  GitHubExternalEventKind,
  type GitHubIssueCommentUpsertEvent,
  type GitHubReviewThreadUpsertEvent,
} from "@/app/comments/service/github/apply-external-events";

/** One branch with its current pull request, in one organization. */
export type GitHubCommentScope = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  repositoryFullName: string;
};

export const GITHUB_TEST_REPOSITORY = "acme/web";
export const GITHUB_TEST_COMMIT_SHA = "a".repeat(40);
export const GITHUB_TEST_AUTHOR = {
  id: 4242,
  login: "octocat",
  node_id: "U_4242",
  avatar_url: "https://avatars.example/4242",
};

const T0 = Date.parse("2026-09-01T00:00:00.000Z");

/** A timestamp `minutes` after a fixed origin, so keys order by construction. */
export function at(minutes: number): Date {
  return new Date(T0 + minutes * 60_000);
}

/**
 * A branch artifact, its branch detail and a current open pull request in
 * `organizationId`. The PR is current: the branch's pointer names it.
 */
export async function seedGitHubCommentScope(
  organizationId: string,
  options: { number?: number; current?: boolean } = {}
): Promise<GitHubCommentScope> {
  const user = await createTestUser(organizationId);
  const suffix = randomUUID().slice(0, 8);
  return await withDb.tx(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        status: BranchStatus.Open,
        name: `feat/github-${suffix}`,
        createdById: user.id,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryFullName: GITHUB_TEST_REPOSITORY,
        branchName: `feat/github-${suffix}`,
      },
      select: { artifactId: true },
    });
    const pr = await db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: branch.id,
        number: options.number ?? 42,
        repositoryFullName: GITHUB_TEST_REPOSITORY,
      },
      select: { id: true },
    });
    if (options.current !== false) {
      await db.branchDetail.update({
        where: { artifactId: branch.id },
        data: { currentPullRequestDetailId: pr.id },
        select: { artifactId: true },
      });
    }
    return {
      organizationId,
      branchArtifactId: branch.id,
      pullRequestDetailId: pr.id,
      repositoryFullName: GITHUB_TEST_REPOSITORY,
    };
  });
}

export function applyInput(
  scope: GitHubCommentScope,
  events: GitHubExternalEvent[]
): ApplyExternalInput {
  return {
    provider: CommentSyncProvider.Github,
    organizationId: scope.organizationId,
    branchArtifactId: scope.branchArtifactId,
    pullRequestDetailId: scope.pullRequestDetailId,
    events,
  };
}

export function externalComment(
  githubCommentId: number,
  over: Partial<GitHubExternalComment> = {}
): GitHubExternalComment {
  return {
    githubCommentId,
    htmlUrl: `https://github.com/${GITHUB_TEST_REPOSITORY}/pull/42#c${githubCommentId}`,
    bodyMarkdown: `body ${githubCommentId}`,
    author: GITHUB_TEST_AUTHOR,
    createdAt: at(0),
    providerUpdatedAt: at(0),
    ...over,
  };
}

export function issueCommentEvent(
  githubCommentId: number,
  over: Partial<GitHubExternalComment> = {},
  reviveDeletedBefore?: Date
): GitHubIssueCommentUpsertEvent {
  return {
    kind: GitHubExternalEventKind.IssueCommentUpsert,
    ...(reviveDeletedBefore === undefined ? {} : { reviveDeletedBefore }),
    comment: externalComment(githubCommentId, over),
  };
}

export function reviewThreadEvent(
  rootCommentId: number,
  input: {
    line?: number | null;
    originalLine?: number | null;
    comments?: GitHubExternalComment[];
    reviveDeletedBefore?: Date;
  } = {}
): GitHubReviewThreadUpsertEvent {
  return {
    kind: GitHubExternalEventKind.ReviewThreadUpsert,
    ...(input.reviveDeletedBefore === undefined
      ? {}
      : { reviveDeletedBefore: input.reviveDeletedBefore }),
    reviewThreadId: `PRRT_${rootCommentId}`,
    reviewId: null,
    rootCommentId,
    position: {
      path: "src/app.ts",
      line: input.line === undefined ? 10 : input.line,
      originalLine: input.originalLine === undefined ? 10 : input.originalLine,
      side: GitHubDiffSide.RIGHT,
      startLine: null,
      startSide: null,
      commitSha: GITHUB_TEST_COMMIT_SHA,
    },
    comments: input.comments ?? [externalComment(rootCommentId)],
  };
}

/** A provider review comment, as the complete review-comment lister returns it. */
export function providerReviewComment(
  id: number,
  over: Partial<GitHubPullRequestReviewComment> = {}
): GitHubPullRequestReviewComment {
  return {
    id,
    node_id: `PRRC_${id}`,
    path: "src/app.ts",
    line: 10,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: 10,
    original_start_line: null,
    body: `review ${id}`,
    user: { ...GITHUB_TEST_AUTHOR },
    author_association: "MEMBER",
    created_at: at(0).toISOString(),
    updated_at: at(0).toISOString(),
    html_url: `https://github.com/${GITHUB_TEST_REPOSITORY}/pull/42#discussion_r${id}`,
    commit_id: GITHUB_TEST_COMMIT_SHA,
    pull_request_review_id: null,
    review_thread_node_id: `PRRT_${id}`,
    review_thread_is_resolved: false,
    in_reply_to_id: null,
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
    ...over,
  };
}

/** A provider issue comment, as the complete issue-comment lister returns it. */
export function providerIssueComment(
  id: number,
  over: Partial<GitHubPullRequestIssueComment> = {}
): GitHubPullRequestIssueComment {
  return {
    id,
    node_id: `IC_${id}`,
    user: { ...GITHUB_TEST_AUTHOR },
    body: `issue ${id}`,
    author_association: "MEMBER",
    created_at: at(0).toISOString(),
    updated_at: at(0).toISOString(),
    html_url: `https://github.com/${GITHUB_TEST_REPOSITORY}/pull/42#issuecomment-${id}`,
    deleted_at: null,
    is_deleted: false,
    is_updated: false,
    ...over,
  };
}

/** A provider review, as the complete review lister returns it. */
export function providerReview(
  id: number,
  body: string | null,
  submittedAt: Date = at(0)
): GitHubPullRequestReviewWithAuthor {
  return {
    id,
    user: { login: GITHUB_TEST_AUTHOR.login, avatar_url: "" },
    author: { ...GITHUB_TEST_AUTHOR },
    state: "COMMENTED",
    body,
    submitted_at: submittedAt.toISOString(),
    html_url: `https://github.com/${GITHUB_TEST_REPOSITORY}/pull/42#pullrequestreview-${id}`,
  };
}

export async function storedComment(
  scope: GitHubCommentScope,
  githubCommentId: number
) {
  return await withDb((db) =>
    db.gitHubCommentProjection.findFirst({
      where: {
        githubCommentId: String(githubCommentId),
        threadProjection: { branchArtifactId: scope.branchArtifactId },
      },
      select: {
        commentId: true,
        threadId: true,
        githubDeletedAt: true,
        comment: {
          select: {
            plainText: true,
            deletedAt: true,
            revision: true,
            syncStates: {
              select: {
                state: true,
                providerUpdatedAt: true,
                syncedRevision: true,
              },
            },
          },
        },
        threadProjection: {
          select: {
            threadKind: true,
            deletedAt: true,
            thread: {
              select: { anchor: true, anchorState: true, revision: true },
            },
          },
        },
      },
    })
  );
}
