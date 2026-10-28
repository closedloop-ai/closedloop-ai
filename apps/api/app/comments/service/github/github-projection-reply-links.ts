import type { GitHubProjectionDb } from "./github-projection-contract";

/**
 * Links every live reply in the thread that has no parent yet to the comment
 * it answers, once that comment is stored: a reply written before its root
 * stays unlinked until then, and a later write of the thread fills it in
 * whether or not that write changed a comment. Returns how many it linked.
 */
export async function linkUnparentedGitHubReplies(
  tx: GitHubProjectionDb,
  threadId: string
): Promise<number> {
  const replies = await tx.gitHubCommentProjection.findMany({
    where: {
      threadId,
      githubInReplyToCommentId: { not: null },
      githubDeletedAt: null,
      comment: { parentCommentId: null, deletedAt: null },
    },
    select: { commentId: true, githubInReplyToCommentId: true },
  });
  const parentRemoteIds = [
    ...new Set(
      replies.flatMap((reply) =>
        reply.githubInReplyToCommentId ? [reply.githubInReplyToCommentId] : []
      )
    ),
  ];
  if (parentRemoteIds.length === 0) {
    return 0;
  }
  const parents = await tx.gitHubCommentProjection.findMany({
    where: { threadId, githubCommentId: { in: parentRemoteIds } },
    select: { commentId: true, githubCommentId: true },
  });
  const parentByRemoteId = new Map(
    parents.map((parent) => [parent.githubCommentId, parent.commentId])
  );
  let linked = 0;
  for (const reply of replies) {
    const parentCommentId = reply.githubInReplyToCommentId
      ? parentByRemoteId.get(reply.githubInReplyToCommentId)
      : undefined;
    if (!parentCommentId || parentCommentId === reply.commentId) {
      continue;
    }
    await tx.comment.update({
      where: { id: reply.commentId },
      data: { parentCommentId },
      select: { id: true },
    });
    linked += 1;
  }
  return linked;
}
