import { ThreadSource } from "@repo/api/src/types/comment";
import { Prisma, type TransactionClient } from "@repo/database";

/**
 * Count comment threads on the artifact itself: native threads plus Liveblocks
 * threads, which only `.md`-bodied artifacts have. Replies do not increment
 * (operator ruling, ISS-9404 review on #8671). A thread whose comments are all
 * deleted is gone; resolved threads count.
 */
export const directCommentCountService = {
  async read(
    db: Pick<TransactionClient, "$queryRaw">,
    organizationId: string,
    artifactIds: readonly string[]
  ): Promise<Map<string, number>> {
    if (!artifactIds.length) {
      return new Map();
    }
    const rows = await db.$queryRaw<
      { artifactId: string; commentCount: number }[]
    >(Prisma.sql`
      SELECT a.id AS "artifactId", COUNT(DISTINCT c.thread_id)::int AS "commentCount"
      FROM artifacts a
      LEFT JOIN comment_threads t ON t.artifact_id = a.id AND t.organization_id = ${organizationId}::uuid
        AND t.source IN (${ThreadSource.Native}::"ThreadSource", ${ThreadSource.Liveblocks}::"ThreadSource")
      LEFT JOIN comments c ON c.thread_id = t.id AND c.deleted_at IS NULL
      WHERE a.organization_id = ${organizationId}::uuid AND a.id = ANY(${artifactIds}::uuid[])
      GROUP BY a.id
    `);
    return new Map(rows.map((row) => [row.artifactId, row.commentCount]));
  },
};
