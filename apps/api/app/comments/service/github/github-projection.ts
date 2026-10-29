import { GitHubCommentThreadKind, ThreadSource } from "@repo/database";
import {
  assertCommentExternalIdsAreScoped,
  upsertProjectedGitHubComments,
} from "./github-projection-comment-write";
import type {
  GitHubProjectionDb,
  UpsertGitHubIssueCommentThreadInput,
  UpsertGitHubProjectionResult,
  UpsertGitHubReviewCommentThreadInput,
  UpsertGitHubReviewSummaryThreadInput,
  UpsertGitHubThreadInput,
} from "./github-projection-contract";
import {
  GitHubCommentProjectionScopeCollisionError,
  gitHubCommentExternalId,
  requireRemoteCommentId,
} from "./github-projection-identity";
import {
  findOrCreateGitHubThread,
  upsertGitHubThreadProjection,
} from "./github-projection-thread-write";

/**
 * The GitHub projection writer. Every export here is called only from
 * `applyExternal` (PLN-2122 Step 3), which applies the ordering and
 * terminal-delete rules before any of these writes run.
 */

/**
 * Upsert one GitHub issue comment into the shared comment projection tables.
 * The remote GitHub comment id is mandatory because branch-view serialization
 * must never synthesize public ids from local Comment ids.
 */
export async function upsertGitHubIssueCommentThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubIssueCommentThreadInput
): Promise<UpsertGitHubProjectionResult> {
  return await upsertSingleCommentThread(tx, {
    ...input,
    threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
    rootCommentId: input.comment.githubCommentId,
  });
}

/**
 * Upsert one review's summary body as its own thread (PLN-2122 decision 6):
 * the review id is both the thread's root and its one comment's remote id.
 */
export async function upsertGitHubReviewSummaryThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubReviewSummaryThreadInput
): Promise<UpsertGitHubProjectionResult> {
  return await upsertSingleCommentThread(tx, {
    ...input,
    threadKind: GitHubCommentThreadKind.REVIEW_SUMMARY,
    rootCommentId: input.reviewId,
    comment: { ...input.comment, githubCommentId: input.reviewId },
  });
}

/**
 * Upsert one GitHub review thread and its comments into the shared projection
 * tables. Callers provide already-resolved FEA-1195 author user ids.
 */
export async function upsertGitHubReviewCommentThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubReviewCommentThreadInput
): Promise<UpsertGitHubProjectionResult> {
  if (input.comments.length === 0) {
    throw new Error("GitHub review thread requires at least one comment");
  }

  return await upsertGitHubThread(tx, {
    ...input,
    threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
    rootCommentId: requireRemoteCommentId(input.rootCommentId),
    resolvable: input.resolvable ?? true,
  });
}

async function upsertSingleCommentThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubIssueCommentThreadInput & {
    threadKind: GitHubCommentThreadKind;
    rootCommentId: string | number;
  }
): Promise<UpsertGitHubProjectionResult> {
  const githubCommentId = requireRemoteCommentId(input.comment.githubCommentId);

  await assertScopedGitHubCommentExternalIdAvailable(tx, {
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
    threadKind: input.threadKind,
    githubCommentId,
  });

  return await upsertGitHubThread(tx, {
    ...input,
    rootCommentId: requireRemoteCommentId(input.rootCommentId),
    reviewThreadId: null,
    reviewId:
      input.threadKind === GitHubCommentThreadKind.REVIEW_SUMMARY
        ? githubCommentId
        : null,
    path: null,
    line: null,
    side: null,
    startLine: null,
    startSide: null,
    commitSha: null,
    comments: [input.comment],
    resolvable: false,
  });
}

/**
 * A comment id stored under another scope refuses the event before anything
 * is written, so the refusal leaves no thread behind.
 */
async function upsertGitHubThread(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput
): Promise<UpsertGitHubProjectionResult> {
  await assertCommentExternalIdsAreScoped(
    tx,
    input,
    input.comments.map((comment) =>
      requireRemoteCommentId(comment.githubCommentId)
    )
  );
  const thread = await findOrCreateGitHubThread(tx, input);
  await upsertGitHubThreadProjection(
    tx,
    thread.id,
    thread.revived ? { ...input, revive: true } : input
  );
  const { threadId, commentIds } = await upsertProjectedGitHubComments(
    tx,
    thread.id,
    input
  );

  return {
    threadId,
    commentIds,
    ...(thread.createdRevision !== null && thread.id === threadId
      ? { createdThread: { id: thread.id, revision: thread.createdRevision } }
      : {}),
  };
}

async function assertScopedGitHubCommentExternalIdAvailable(
  tx: GitHubProjectionDb,
  input: {
    organizationId: string;
    branchArtifactId: string;
    pullRequestDetailId: string;
    threadKind: GitHubCommentThreadKind;
    githubCommentId: string;
  }
): Promise<void> {
  const existing = await tx.comment.findUnique({
    where: {
      externalId: gitHubCommentExternalId(
        input.threadKind,
        input.githubCommentId
      ),
    },
    select: {
      thread: {
        select: {
          organizationId: true,
          artifactId: true,
          source: true,
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
  });

  if (!existing) {
    return;
  }

  const projection = existing.thread.githubProjection;
  const sameScope =
    existing.thread.organizationId === input.organizationId &&
    existing.thread.artifactId === input.branchArtifactId &&
    existing.thread.source === ThreadSource.GITHUB &&
    projection !== null &&
    projection.branchArtifactId === input.branchArtifactId &&
    projection.pullRequestDetailId === input.pullRequestDetailId &&
    projection.threadKind === input.threadKind;

  if (!sameScope) {
    throw new GitHubCommentProjectionScopeCollisionError(input.githubCommentId);
  }
}
