import {
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import {
  type GitHubCommentThreadKind,
  ThreadSource,
  type TransactionClient,
} from "@repo/database";
import type { GitHubFetchProvenance } from "@/lib/github-fetch-provenance";
import type { ThreadChange } from "../comment-thread-signal";
import { ThreadChangeKind } from "../comment-thread-signal";
import type { StoredGitHubComment } from "./apply-external-ordering";
import type { GitHubReviewThreadPosition } from "./github-projection-contract";
import { requireRemoteCommentId } from "./github-projection-identity";

/** The thread a stored GitHub comment hangs on, as a thread-level write compares it. */
export type StoredGitHubThread = GitHubReviewThreadPosition & {
  threadId: string;
  htmlUrl: string | null;
  reviewThreadId: string | null;
  reviewId: string | null;
  legacyState: string | null;
  status: string;
  /** When the thread row was last written locally. */
  updatedAt: Date;
  deleted: boolean;
};

export type StoredGitHubCommentWithThread = StoredGitHubComment & {
  thread: StoredGitHubThread;
  parentCommentId: string | null;
};

/** Everything one `applyExternal` call shares across its events. */
export type ApplyExternalContext = {
  tx: TransactionClient;
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  pullNumber: number;
  repositoryId: string | null;
  repositoryFullName: string | null;
  fetchProvenance?: GitHubFetchProvenance;
  now: Date;
  stored: ReadonlyMap<string, StoredGitHubCommentWithThread>;
  changes: Map<string, ThreadChange>;
  /** Comments the call's list cleanups deleted. */
  retractedComments: number;
};

export function storedCommentKey(
  threadKind: GitHubCommentThreadKind,
  githubCommentId: string | number
): string {
  return `${threadKind}:${requireRemoteCommentId(githubCommentId)}`;
}

/**
 * Serializes every `applyExternal` call that names the same GitHub comment in
 * one organization, so the ordering rules judge each delivery against what the
 * previous one committed rather than against a snapshot both read (two
 * webhooks, or a webhook and a reconcile chunk). Taken before the stored state
 * is read and held to the end of the transaction. Keys are deduplicated and
 * sorted here, the only sort, so two calls naming overlapping comments lock
 * them in one order (`advisory_xact_lock_text_keys_in_order`, ISS-11608).
 */
export async function lockGitHubComments(
  tx: Pick<TransactionClient, "$executeRaw">,
  organizationId: string,
  remoteIds: readonly string[]
): Promise<void> {
  const keys = [
    ...new Set(
      remoteIds.map(
        (id) => `${GITHUB_COMMENT_LOCK_PREFIX}${organizationId}:${id}`
      )
    ),
  ].sort();
  if (keys.length === 0) {
    return;
  }
  if (keys.length === 1) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${keys[0]}, 0::bigint))`;
    return;
  }
  await tx.$executeRaw`SELECT advisory_xact_lock_text_keys_in_order(${keys}::text[])`;
}

/**
 * Step 1 of the plan's pipeline: the stored state of every comment the events
 * name, in one query, scoped to the organization, branch and pull request.
 * Soft-deleted rows are read too: the terminal-delete rule needs to see them.
 * Read under {@link lockGitHubComments}.
 */
export async function loadStoredGitHubComments(
  tx: TransactionClient,
  scope: {
    organizationId: string;
    branchArtifactId: string;
    pullRequestDetailId: string;
  },
  remoteIds: readonly string[]
): Promise<Map<string, StoredGitHubCommentWithThread>> {
  if (remoteIds.length === 0) {
    return new Map();
  }
  const rows = await tx.gitHubCommentProjection.findMany({
    where: {
      githubCommentId: { in: [...new Set(remoteIds)] },
      threadProjection: {
        branchArtifactId: scope.branchArtifactId,
        pullRequestDetailId: scope.pullRequestDetailId,
        thread: {
          organizationId: scope.organizationId,
          artifactId: scope.branchArtifactId,
          source: ThreadSource.GITHUB,
        },
      },
    },
    select: {
      commentId: true,
      threadId: true,
      githubCommentId: true,
      githubUpdatedAt: true,
      githubDeletedAt: true,
      threadProjection: {
        select: {
          threadKind: true,
          path: true,
          line: true,
          originalLine: true,
          side: true,
          startLine: true,
          startSide: true,
          commitSha: true,
          htmlUrl: true,
          reviewThreadId: true,
          reviewId: true,
          legacyState: true,
          deletedAt: true,
          thread: { select: { status: true, updatedAt: true } },
        },
      },
      comment: {
        select: {
          deletedAt: true,
          plainText: true,
          revision: true,
          updatedAt: true,
          parentCommentId: true,
          syncStates: {
            where: {
              provider: CommentSyncProvider.Github,
              direction: CommentSyncDirection.Inbound,
            },
            select: { providerUpdatedAt: true },
          },
        },
      },
    },
  });
  const stored = new Map<string, StoredGitHubCommentWithThread>();
  for (const row of rows) {
    if (!row.githubCommentId) {
      continue;
    }
    const projection = row.threadProjection;
    const key = storedCommentKey(projection.threadKind, row.githubCommentId);
    const deletedAt = row.githubDeletedAt ?? row.comment.deletedAt;
    const deleted = deletedAt !== null;
    if (deleted && stored.get(key)?.deleted === false) {
      continue;
    }
    stored.set(key, {
      commentId: row.commentId,
      threadId: row.threadId,
      key: laterDate(
        row.comment.syncStates[0]?.providerUpdatedAt ?? null,
        row.githubUpdatedAt
      ),
      writtenAt: row.comment.updatedAt,
      body: row.comment.plainText,
      deleted,
      deletedAt,
      revision: row.comment.revision,
      parentCommentId: row.comment.parentCommentId,
      thread: {
        threadId: row.threadId,
        path: projection.path,
        line: projection.line,
        originalLine: projection.originalLine,
        side: projection.side,
        startLine: projection.startLine,
        startSide: projection.startSide,
        commitSha: projection.commitSha,
        htmlUrl: projection.htmlUrl,
        reviewThreadId: projection.reviewThreadId,
        reviewId: projection.reviewId,
        legacyState: projection.legacyState,
        status: projection.thread.status,
        updatedAt: projection.thread.updatedAt,
        deleted: projection.deletedAt !== null,
      },
    });
  }
  return stored;
}

/** Step 4: the comment's inbound GitHub sync state, confirmed at this key. */
export async function markGitHubCommentSynced(
  ctx: ApplyExternalContext,
  input: {
    commentId: string;
    providerUpdatedAt: Date | null;
    syncedRevision: number;
  }
): Promise<void> {
  const state = {
    state: CommentSyncStatus.Synced,
    providerUpdatedAt: input.providerUpdatedAt,
    syncedRevision: input.syncedRevision,
    lastErrorCode: null,
  };
  await ctx.tx.commentSyncState.upsert({
    where: {
      commentId_provider_direction: {
        commentId: input.commentId,
        provider: CommentSyncProvider.Github,
        direction: CommentSyncDirection.Inbound,
      },
    },
    create: {
      organizationId: ctx.organizationId,
      commentId: input.commentId,
      provider: CommentSyncProvider.Github,
      direction: CommentSyncDirection.Inbound,
      ...state,
    },
    update: state,
    select: { id: true },
  });
}

/** One signal per changed thread per call; a creation outranks an update. */
export function recordThreadChange(
  ctx: ApplyExternalContext,
  change: ThreadChange
): void {
  const existing = ctx.changes.get(change.threadId);
  if (existing?.kind === ThreadChangeKind.Created) {
    return;
  }
  ctx.changes.set(change.threadId, change);
}

const GITHUB_COMMENT_LOCK_PREFIX = "iss-11212:github-comment:";

/**
 * The stored ordering key. The API bundle before this one writes the
 * projection's `githubUpdatedAt` and never the sync row, so while both bundles
 * serve, either can hold the newer key.
 */
function laterDate(a: Date | null, b: Date | null): Date | null {
  if (!(a && b)) {
    return a ?? b;
  }
  return a.getTime() >= b.getTime() ? a : b;
}
