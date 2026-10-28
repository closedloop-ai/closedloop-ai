import { ThreadSource } from "@repo/database";
import {
  type GitHubFetchProvenance,
  gitHubFetchProvenanceData,
} from "@/lib/github-fetch-provenance";
import type {
  GitHubProjectionDb,
  SoftDeletedGitHubCommentRows,
  SoftDeleteGitHubCommentByRemoteIdInput,
  SoftDeleteGitHubCommentProjectionInput,
} from "./github-projection-contract";
import {
  requireRemoteCommentId,
  scopedThreadProjectionWhere,
} from "./github-projection-identity";
import { softDeleteGitHubThreadProjection } from "./github-projection-thread-write";

/**
 * Soft-delete stale unified GitHub projection rows for a current branch PR,
 * reporting the rows it touched: a comment of this kind absent from a complete
 * provider list is deleted, and a thread it leaves with no live comment is
 * deleted with it. A comment GitHub created or edited after the list was read
 * cannot be in it, so it is kept; GitHub stamps whole seconds, so one stamped
 * in the second the list was read is kept too. A comment written here after
 * the list was read is kept as well, whatever GitHub stamped it: a review
 * summary's stamp is `submitted_at`, which its edits keep. Both bounds are
 * re-checked by each write, after `lockComments` has taken the stale
 * comments' locks, so a webhook that commits between the read and the write
 * still wins. At most
 * `maxComments` comments are deleted per call, so a caller repeats the cleanup
 * until it touches nothing; a thread still holding a stale comment survives
 * until that comment goes. Unified comment projection storage only.
 */
export async function softDeleteAbsentGitHubComments(
  tx: GitHubProjectionDb,
  input: SoftDeleteGitHubCommentProjectionInput,
  lockComments: (githubCommentIds: string[]) => Promise<void>
): Promise<SoftDeletedGitHubCommentRows> {
  const liveIds = new Set(
    [...input.liveGithubCommentIds].map((id) => requireRemoteCommentId(id))
  );
  const listedAtSecond = wholeSecond(input.listedAt);

  const staleComments = await tx.gitHubCommentProjection.findMany({
    where: {
      githubCommentId:
        liveIds.size > 0 ? { notIn: [...liveIds], not: null } : { not: null },
      githubDeletedAt: null,
      OR: [
        { githubUpdatedAt: null },
        { githubUpdatedAt: { lt: listedAtSecond } },
      ],
      threadProjection: {
        ...scopedThreadProjectionWhere(input),
        threadKind: input.threadKind,
      },
      comment: {
        deletedAt: null,
        createdAt: { lt: listedAtSecond },
        updatedAt: { lt: input.listedAt },
        thread: {
          organizationId: input.organizationId,
          artifactId: input.branchArtifactId,
          source: ThreadSource.GITHUB,
        },
      },
    },
    select: { commentId: true, threadId: true, githubCommentId: true },
    take: Math.max(1, input.maxComments),
  });
  if (staleComments.length === 0) {
    return { commentIds: [], threadIds: [], deletedThreadCount: 0 };
  }

  await lockComments(
    staleComments.flatMap((row) =>
      row.githubCommentId ? [row.githubCommentId] : []
    )
  );
  // The provider bound is a predicate on this row, so it is re-checked on the
  // row version a concurrent writer commits; the local write time is read by
  // this statement, after the locks, so it sees every writer that held one.
  const deleted = await tx.gitHubCommentProjection.updateManyAndReturn({
    where: {
      commentId: { in: staleComments.map((row) => row.commentId) },
      githubDeletedAt: null,
      OR: [
        { githubUpdatedAt: null },
        { githubUpdatedAt: { lt: listedAtSecond } },
      ],
      comment: { updatedAt: { lt: input.listedAt } },
    },
    data: {
      githubDeletedAt: input.deletedAt,
      ...gitHubFetchProvenanceData(input.fetchProvenance),
    },
    select: { commentId: true },
  });
  const deletedIds = new Set(deleted.map((row) => row.commentId));
  const deletedRows = staleComments.filter((row) =>
    deletedIds.has(row.commentId)
  );
  for (const row of deletedRows) {
    await tx.comment.update({
      where: { id: row.commentId },
      data: { deletedAt: input.deletedAt },
      select: { id: true },
    });
  }

  const threadIds = [...new Set(deletedRows.map((row) => row.threadId))];
  const deletedThreadCount = await softDeleteEmptiedThreads(
    tx,
    threadIds,
    input
  );
  return {
    commentIds: deletedRows.map((row) => row.commentId),
    threadIds,
    deletedThreadCount,
  };
}

/**
 * Soft-delete one scoped GitHub comment projection by remote id, reporting the
 * rows it touched. Webhook delete events use this path so a single deleted
 * comment never stale-cleans unrelated comments in the same PR.
 */
export async function softDeleteGitHubCommentRowsByRemoteId(
  tx: GitHubProjectionDb,
  input: SoftDeleteGitHubCommentByRemoteIdInput
): Promise<SoftDeletedGitHubCommentRows> {
  const githubCommentId = requireRemoteCommentId(input.githubCommentId);
  const scopedThreadWhere = scopedThreadProjectionWhere(input);
  const rows = await tx.gitHubCommentProjection.findMany({
    where: {
      githubCommentId,
      githubDeletedAt: null,
      comment: { deletedAt: null },
      threadProjection: {
        ...scopedThreadWhere,
        threadKind: input.threadKind,
      },
    },
    select: { commentId: true, threadId: true },
  });

  await softDeleteCommentRows(tx, rows, input);

  const affectedThreadIds = [...new Set(rows.map((row) => row.threadId))];
  const deletedThreadCount = await softDeleteEmptiedThreads(
    tx,
    affectedThreadIds,
    input
  );

  return {
    commentIds: rows.map((row) => row.commentId),
    threadIds: affectedThreadIds,
    deletedThreadCount,
  };
}

async function softDeleteCommentRows(
  tx: GitHubProjectionDb,
  rows: readonly { commentId: string }[],
  input: Pick<
    SoftDeleteGitHubCommentProjectionInput,
    "deletedAt" | "fetchProvenance"
  >
): Promise<void> {
  for (const row of rows) {
    await tx.gitHubCommentProjection.update({
      where: { commentId: row.commentId },
      data: {
        githubDeletedAt: input.deletedAt,
        ...gitHubFetchProvenanceData(input.fetchProvenance),
      },
      select: { commentId: true },
    });
    await tx.comment.update({
      where: { id: row.commentId },
      data: { deletedAt: input.deletedAt },
      select: { id: true },
    });
  }
}

/**
 * Which of these threads still hold at least one comment neither projection-
 * deleted nor comment-deleted — the set form of the per-thread existence probe
 * a caller would otherwise issue once per thread (ISS-9116).
 *
 * `distinct` bounds the rows RETURNED by the thread count. It does not bound
 * the rows examined, which stays proportional to the live comments across those
 * threads either way.
 */
async function findThreadIdsWithLiveComments(
  tx: GitHubProjectionDb,
  threadIds: readonly string[]
): Promise<Set<string>> {
  if (threadIds.length === 0) {
    return new Set();
  }
  const rows = await tx.gitHubCommentProjection.findMany({
    where: {
      threadId: { in: [...threadIds] },
      githubDeletedAt: null,
      comment: { deletedAt: null },
    },
    select: { threadId: true },
    distinct: ["threadId"],
  });
  return new Set(rows.map((row) => row.threadId));
}

/**
 * Soft-delete each of these threads that no longer holds a live comment,
 * returning how many. One existence question over the set, issued after the
 * comment deletes that decide it.
 */
async function softDeleteEmptiedThreads(
  tx: GitHubProjectionDb,
  threadIds: readonly string[],
  input: { deletedAt: Date; fetchProvenance?: GitHubFetchProvenance }
): Promise<number> {
  const threadIdsWithLiveComments = await findThreadIdsWithLiveComments(
    tx,
    threadIds
  );
  let deletedThreadCount = 0;
  for (const threadId of threadIds) {
    if (threadIdsWithLiveComments.has(threadId)) {
      continue;
    }
    await softDeleteGitHubThreadProjection(tx, threadId, input);
    deletedThreadCount += 1;
  }
  return deletedThreadCount;
}

function wholeSecond(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}
