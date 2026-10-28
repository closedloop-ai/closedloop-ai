import type { TransactionClient } from "@repo/database";

/**
 * The comment that opened a thread and the thread's author, whether or not
 * that comment is still live. A synced thread keeps its replies when the
 * provider deletes its first comment, so the first live comment is not the
 * root, and its author is not the thread's.
 */
export type ThreadOrigin = {
  rootCommentId: string;
  /** The stored creator, else the opening comment's author. */
  authorId: string;
};

export async function findThreadOrigin(
  db: Pick<TransactionClient, "commentThread">,
  input: { organizationId: string; threadId: string }
): Promise<ThreadOrigin | null> {
  const thread = await db.commentThread.findFirst({
    where: { id: input.threadId, organizationId: input.organizationId },
    select: {
      createdById: true,
      comments: {
        select: { id: true, authorId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1,
      },
    },
  });
  const root = thread?.comments[0];
  if (!(thread && root)) {
    return null;
  }
  return {
    rootCommentId: root.id,
    authorId: thread.createdById ?? root.authorId,
  };
}
