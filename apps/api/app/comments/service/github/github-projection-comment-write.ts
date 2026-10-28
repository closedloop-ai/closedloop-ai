import { ThreadSource } from "@repo/database";
import { githubMarkdownCommentBodyFields } from "@/app/comments/github-markdown-comment-body";
import { gitHubFetchProvenanceData } from "@/lib/github-fetch-provenance";
import type {
  GitHubProjectionCommentInput,
  GitHubProjectionDb,
  UpsertGitHubThreadInput,
} from "./github-projection-contract";
import {
  GitHubProjectionNoWriteCode,
  GitHubProjectionNoWriteError,
  gitHubCommentExternalId,
  optionalRemoteCommentId,
  requireRemoteCommentId,
  scopedThreadProjectionWhere,
} from "./github-projection-identity";
import { upsertGitHubThreadProjection } from "./github-projection-thread-write";

type ProjectedComments = {
  threadId: string;
  commentIds: string[];
};

type ScopedComment = { id: string; threadId: string; deleted: boolean };

export async function upsertProjectedGitHubComments(
  tx: GitHubProjectionDb,
  threadId: string,
  input: UpsertGitHubThreadInput
): Promise<ProjectedComments> {
  const remoteCommentIds = input.comments.map((comment) =>
    requireRemoteCommentId(comment.githubCommentId)
  );
  let targetThreadId = threadId;
  const commentIds: string[] = [];
  const localCommentIdByRemoteId = new Map<string, string>();
  const pendingParentLinks: {
    commentId: string;
    githubInReplyToCommentId: string | null;
  }[] = [];
  const existingScopedThreadId = await findScopedThreadIdForRemoteComments(
    tx,
    input,
    remoteCommentIds
  );
  if (existingScopedThreadId && existingScopedThreadId !== targetThreadId) {
    targetThreadId = existingScopedThreadId;
    await upsertGitHubThreadProjection(tx, targetThreadId, input);
  }
  for (const [index, commentInput] of input.comments.entries()) {
    const githubCommentId = remoteCommentIds[index];
    if (!githubCommentId) {
      throw new Error("Missing normalized GitHub comment id");
    }
    const githubInReplyToCommentId = optionalRemoteCommentId(
      commentInput.githubInReplyToCommentId
    );
    const parentCommentId = githubInReplyToCommentId
      ? (localCommentIdByRemoteId.get(githubInReplyToCommentId) ??
        (await findCommentIdForRemoteId(
          tx,
          targetThreadId,
          githubInReplyToCommentId
        )))
      : null;

    const comment = await createOrUpdateProjectedComment(tx, {
      threadId: targetThreadId,
      scopeInput: input,
      githubCommentId,
      commentInput,
      githubInReplyToCommentId,
      parentCommentId,
    });
    if (comment.threadId !== targetThreadId) {
      targetThreadId = comment.threadId;
      await upsertGitHubThreadProjection(tx, targetThreadId, input);
    }

    const projection = {
      threadId: targetThreadId,
      externalAuthorId: commentInput.author.externalAuthorId ?? null,
      githubCommentId,
      githubInReplyToCommentId,
      githubHtmlUrl: commentInput.githubHtmlUrl ?? null,
      githubUpdatedAt: commentInput.githubUpdatedAt ?? null,
      ...gitHubFetchProvenanceData(input.fetchProvenance),
    };
    await tx.gitHubCommentProjection.upsert({
      where: { commentId: comment.id },
      create: { commentId: comment.id, ...projection, githubDeletedAt: null },
      update: input.revive
        ? { ...projection, githubDeletedAt: null }
        : projection,
      select: { commentId: true },
    });

    localCommentIdByRemoteId.set(githubCommentId, comment.id);
    pendingParentLinks.push({
      commentId: comment.id,
      githubInReplyToCommentId,
    });
    commentIds.push(comment.id);
  }

  await backfillGitHubCommentParentLinks(
    tx,
    targetThreadId,
    pendingParentLinks,
    localCommentIdByRemoteId
  );

  return { threadId: targetThreadId, commentIds };
}

type ProjectedCommentWrite = {
  threadId: string;
  scopeInput: UpsertGitHubThreadInput;
  githubCommentId: string;
  commentInput: GitHubProjectionCommentInput;
  githubInReplyToCommentId: string | null;
  parentCommentId: string | null;
};

async function createOrUpdateProjectedComment(
  tx: GitHubProjectionDb,
  input: ProjectedCommentWrite
): Promise<{ id: string; threadId: string }> {
  const externalId = gitHubCommentExternalId(
    input.scopeInput.threadKind,
    input.githubCommentId
  );
  const data = projectedCommentData(input);
  const existingScopedComment =
    (await findScopedProjectionCommentByRemoteId(
      tx,
      input.scopeInput,
      input.githubCommentId
    )) ??
    (await findScopedCommentByRemoteId(
      tx,
      input.scopeInput,
      input.githubCommentId
    ));
  if (existingScopedComment) {
    assertWritable(existingScopedComment, input);
    const recoveryParentCommentId = await resolveProjectedParentCommentId(
      tx,
      input,
      existingScopedComment.threadId
    );
    const comment = await tx.comment.update({
      where: { id: existingScopedComment.id },
      data: {
        ...data,
        threadId: existingScopedComment.threadId,
        parentCommentId: recoveryParentCommentId,
      },
      select: { id: true, threadId: true },
    });
    return comment;
  }

  // A unique violation aborts the transaction, which the caller runs again
  // (`withGitHubCommentWriteRetry`); the retry finds the row above.
  return await tx.comment.create({
    data: {
      ...data,
      externalId,
      createdAt: input.commentInput.createdAt,
    },
    select: { id: true, threadId: true },
  });
}

/** PLN-2122 decision 2: a deleted comment is written again only by a revival. */
function assertWritable(
  existing: ScopedComment,
  input: ProjectedCommentWrite
): void {
  if (existing.deleted && !input.scopeInput.revive) {
    throw new GitHubProjectionNoWriteError(
      GitHubProjectionNoWriteCode.DeletedComment,
      {
        githubCommentId: input.githubCommentId,
        branchArtifactId: input.scopeInput.branchArtifactId,
        pullRequestDetailId: input.scopeInput.pullRequestDetailId,
      }
    );
  }
}

async function resolveProjectedParentCommentId(
  tx: GitHubProjectionDb,
  input: {
    threadId: string;
    githubInReplyToCommentId: string | null;
    parentCommentId: string | null;
  },
  recoveryThreadId: string
): Promise<string | null> {
  if (!input.githubInReplyToCommentId) {
    return null;
  }
  return input.threadId === recoveryThreadId
    ? input.parentCommentId
    : await findCommentIdForRemoteId(
        tx,
        recoveryThreadId,
        input.githubInReplyToCommentId
      );
}

function projectedCommentData(input: ProjectedCommentWrite) {
  return {
    threadId: input.threadId,
    authorId: input.commentInput.author.userId,
    ...githubMarkdownCommentBodyFields(input.commentInput.bodyMarkdown),
    plainText: input.commentInput.bodyMarkdown,
    parentCommentId: input.parentCommentId,
    editedAt: gitHubEditedAt(input.commentInput),
    ...(input.scopeInput.revive ? { deletedAt: null } : {}),
  };
}

export async function assertCommentExternalIdsAreScoped(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput,
  remoteCommentIds: string[]
): Promise<void> {
  if (remoteCommentIds.length === 0) {
    return;
  }
  // `externalId` is globally unique, so one `in` returns exactly the rows the
  // per-id `findUnique`s returned. The loop below still walks
  // `remoteCommentIds` in order, so a payload with several conflicting ids
  // still reports the first of them.
  const existingComments = await tx.comment.findMany({
    where: {
      externalId: {
        in: remoteCommentIds.map((githubCommentId) =>
          gitHubCommentExternalId(input.threadKind, githubCommentId)
        ),
      },
    },
    select: {
      id: true,
      threadId: true,
      externalId: true,
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
              deletedAt: true,
            },
          },
        },
      },
    },
  });
  const existingByExternalId = new Map(
    existingComments.map((comment) => [comment.externalId, comment])
  );
  for (const githubCommentId of remoteCommentIds) {
    const existingComment = existingByExternalId.get(
      gitHubCommentExternalId(input.threadKind, githubCommentId)
    );
    if (!existingComment) {
      continue;
    }

    const projection = existingComment.thread.githubProjection;
    const sameScope =
      existingComment.thread.organizationId === input.organizationId &&
      existingComment.thread.artifactId === input.branchArtifactId &&
      existingComment.thread.source === ThreadSource.GITHUB &&
      projection?.branchArtifactId === input.branchArtifactId &&
      projection.pullRequestDetailId === input.pullRequestDetailId &&
      projection.threadKind === input.threadKind;
    if (!sameScope) {
      throw new GitHubProjectionNoWriteError(
        GitHubProjectionNoWriteCode.ExternalIdConflict,
        {
          githubCommentId,
          existingCommentId: existingComment.id,
          existingThreadId: existingComment.threadId,
          branchArtifactId: input.branchArtifactId,
          pullRequestDetailId: input.pullRequestDetailId,
        }
      );
    }
  }
}

async function findScopedThreadIdForRemoteComments(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput,
  remoteCommentIds: string[]
): Promise<string | null> {
  const rows = await tx.comment.findMany({
    where: {
      externalId: {
        in: remoteCommentIds.map((id) =>
          gitHubCommentExternalId(input.threadKind, id)
        ),
      },
      thread: {
        organizationId: input.organizationId,
        artifactId: input.branchArtifactId,
        source: ThreadSource.GITHUB,
        githubProjection: {
          branchArtifactId: input.branchArtifactId,
          pullRequestDetailId: input.pullRequestDetailId,
          threadKind: input.threadKind,
        },
      },
    },
    select: { threadId: true },
    distinct: ["threadId"],
    take: 2,
  });
  if (rows.length > 1) {
    throw new GitHubProjectionNoWriteError(
      GitHubProjectionNoWriteCode.AmbiguousThreadProjection,
      {
        branchArtifactId: input.branchArtifactId,
        pullRequestDetailId: input.pullRequestDetailId,
        rootCommentId: input.rootCommentId,
        reviewThreadId: input.reviewThreadId ?? null,
      }
    );
  }
  return rows[0]?.threadId ?? null;
}

async function findScopedCommentByRemoteId(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput,
  githubCommentId: string
): Promise<ScopedComment | null> {
  const row = await tx.comment.findFirst({
    where: {
      externalId: gitHubCommentExternalId(input.threadKind, githubCommentId),
      thread: {
        organizationId: input.organizationId,
        artifactId: input.branchArtifactId,
        source: ThreadSource.GITHUB,
        githubProjection: {
          branchArtifactId: input.branchArtifactId,
          pullRequestDetailId: input.pullRequestDetailId,
          threadKind: input.threadKind,
        },
      },
    },
    select: { id: true, threadId: true, deletedAt: true },
  });
  return row
    ? { id: row.id, threadId: row.threadId, deleted: Boolean(row.deletedAt) }
    : null;
}

async function findScopedProjectionCommentByRemoteId(
  tx: GitHubProjectionDb,
  input: UpsertGitHubThreadInput,
  githubCommentId: string
): Promise<ScopedComment | null> {
  const row = await tx.gitHubCommentProjection.findFirst({
    where: {
      githubCommentId,
      threadProjection: {
        ...scopedThreadProjectionWhere(input),
        threadKind: input.threadKind,
      },
    },
    select: {
      commentId: true,
      threadId: true,
      githubDeletedAt: true,
      comment: { select: { deletedAt: true } },
    },
  });
  return row
    ? {
        id: row.commentId,
        threadId: row.threadId,
        deleted: Boolean(row.githubDeletedAt || row.comment?.deletedAt),
      }
    : null;
}

async function backfillGitHubCommentParentLinks(
  tx: GitHubProjectionDb,
  threadId: string,
  pendingParentLinks: {
    commentId: string;
    githubInReplyToCommentId: string | null;
  }[],
  localCommentIdByRemoteId: ReadonlyMap<string, string>
): Promise<void> {
  for (const link of pendingParentLinks) {
    if (!link.githubInReplyToCommentId) {
      continue;
    }

    const parentCommentId =
      localCommentIdByRemoteId.get(link.githubInReplyToCommentId) ??
      (await findCommentIdForRemoteId(
        tx,
        threadId,
        link.githubInReplyToCommentId
      ));
    if (!(parentCommentId && parentCommentId !== link.commentId)) {
      continue;
    }

    await tx.comment.update({
      where: { id: link.commentId },
      data: { parentCommentId },
      select: { id: true },
    });
  }
}

function gitHubEditedAt(
  comment: Pick<GitHubProjectionCommentInput, "createdAt" | "githubUpdatedAt">
): Date | null {
  if (
    !comment.githubUpdatedAt ||
    comment.githubUpdatedAt.getTime() === comment.createdAt.getTime()
  ) {
    return null;
  }
  return comment.githubUpdatedAt;
}

async function findCommentIdForRemoteId(
  tx: GitHubProjectionDb,
  threadId: string,
  githubCommentId: string
): Promise<string | null> {
  const row = await tx.gitHubCommentProjection.findFirst({
    where: { threadId, githubCommentId },
    select: { commentId: true },
  });
  return row?.commentId ?? null;
}
