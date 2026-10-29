import { ArtifactType } from "@repo/api/src/types/artifact";
import { ThreadSource } from "@repo/api/src/types/comment";
import { Prisma, type PrismaClient } from "@repo/database";

const MAX_COMMENT_AUTHORS_PER_SESSION = 1000;

export type SessionCommentEvidence = {
  authorIds: string[];
  capped: boolean;
};

type CommentAuthorRow = {
  artifactId: string;
  authorId: string;
  rowRank: number;
};

/** Read Session authors from native and Liveblocks comment rows. */
export async function readSessionCommentEvidence(
  db: Pick<PrismaClient, "$queryRaw">,
  organizationId: string,
  artifactIds: readonly string[]
): Promise<Map<string, SessionCommentEvidence>> {
  if (artifactIds.length === 0) {
    return new Map();
  }
  const artifactSql = Prisma.join(
    artifactIds.map((id) => Prisma.sql`${id}::uuid`)
  );
  const rows = await db.$queryRaw<CommentAuthorRow[]>(Prisma.sql`
    WITH authors AS (
      SELECT DISTINCT t.artifact_id, c.author_id
      FROM comments c
      JOIN comment_threads t ON t.id = c.thread_id
      JOIN artifacts a ON a.id = t.artifact_id
        AND a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.Session}::"ArtifactType"
      WHERE t.organization_id = ${organizationId}::uuid
        AND t.source IN (
          ${ThreadSource.Native}::"ThreadSource",
          ${ThreadSource.Liveblocks}::"ThreadSource"
        )
        AND t.artifact_id IN (${artifactSql})
        AND c.deleted_at IS NULL
    ), ranked AS (
      SELECT artifact_id, author_id,
        row_number() OVER (PARTITION BY artifact_id ORDER BY author_id) AS row_rank
      FROM authors
    )
    SELECT artifact_id AS "artifactId", author_id AS "authorId",
      row_rank::int AS "rowRank"
    FROM ranked
    WHERE row_rank <= ${MAX_COMMENT_AUTHORS_PER_SESSION + 1}
  `);
  const evidence = new Map<string, SessionCommentEvidence>();
  for (const row of rows) {
    let session = evidence.get(row.artifactId);
    if (!session) {
      session = { authorIds: [], capped: false };
      evidence.set(row.artifactId, session);
    }
    if (row.rowRank > MAX_COMMENT_AUTHORS_PER_SESSION) {
      session.capped = true;
    } else {
      session.authorIds.push(row.authorId);
    }
  }
  return evidence;
}
