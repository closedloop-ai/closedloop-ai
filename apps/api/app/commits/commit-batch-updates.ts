import {
  type CommitDetail,
  Prisma,
  type TransactionClient,
} from "@repo/database";
import { bindParameterChunkSize } from "@/app/agent-sessions/service/write-chunking";
import { getPrismaRawQuerySqlState } from "@/lib/db-utils";

export type CommitUpdateData = Pick<
  CommitDetail,
  | "sha"
  | "source"
  | "message"
  | "committedAt"
  | "authoredAt"
  | "authorName"
  | "authorEmail"
  | "authorLogin"
  | "linesAdded"
  | "linesRemoved"
  | "filesChanged"
  | "isMerge"
  | "mergeCommitSha"
>;

type CommitUpdate = {
  id: string;
  organizationId: string;
  data: CommitUpdateData;
};
const UPDATE_CHUNK = bindParameterChunkSize(15, 1);

export async function updateCommitBatch(
  tx: TransactionClient,
  updates: readonly CommitUpdate[]
): Promise<void> {
  for (let index = 0; index < updates.length; index += UPDATE_CHUNK) {
    const values = Prisma.join(
      updates.slice(index, index + UPDATE_CHUNK).map(
        ({ id, organizationId, data }) =>
          Prisma.sql`(${id}::uuid, ${organizationId}::uuid, ${data.sha}::text,
          ${data.source}::text, ${data.message}::text,
          ${data.committedAt}::timestamp, ${data.authoredAt}::timestamp,
          ${data.authorName}::text, ${data.authorEmail}::text,
          ${data.authorLogin}::text, ${data.linesAdded}::integer,
          ${data.linesRemoved}::integer, ${data.filesChanged}::integer,
          ${data.isMerge}::boolean, ${data.mergeCommitSha}::text)`
      )
    );
    try {
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE commit_detail AS commits
        SET sha = v.sha, source = v.source, message = v.message,
            committed_at = v.committed_at, authored_at = v.authored_at,
            author_name = v.author_name, author_email = v.author_email,
            author_login = v.author_login, lines_added = v.lines_added,
            lines_removed = v.lines_removed, files_changed = v.files_changed,
            is_merge = v.is_merge, merge_commit_sha = v.merge_commit_sha,
            updated_at = ${new Date()}
        FROM (VALUES ${values}) AS v(id, organization_id, sha, source, message,
          committed_at, authored_at, author_name, author_email, author_login,
          lines_added, lines_removed, files_changed, is_merge, merge_commit_sha)
        WHERE commits.id = v.id AND commits.organization_id = v.organization_id
      `);
      if (changed !== Math.min(UPDATE_CHUNK, updates.length - index)) {
        throw new Prisma.PrismaClientKnownRequestError(
          "Commit row disappeared",
          {
            code: "P2025",
            clientVersion: Prisma.prismaVersion.client,
          }
        );
      }
    } catch (error) {
      // Preserve the webhook's unique-conflict retry after the transaction rolls back.
      if (getPrismaRawQuerySqlState(error) === "23505") {
        throw new Prisma.PrismaClientKnownRequestError(
          "Commit identity conflict",
          {
            code: "P2002",
            clientVersion: Prisma.prismaVersion.client,
            meta: { target: ["organizationId", "repositoryFullName", "sha"] },
          }
        );
      }
      throw error;
    }
  }
}
