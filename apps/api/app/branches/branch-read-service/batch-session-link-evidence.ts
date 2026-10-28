import { ArtifactType } from "@repo/api/src/types/artifact";
import type { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import { Prisma, type PrismaClient } from "@repo/database";
import {
  branchOwnerIdentityLateralSql,
  sessionEvidenceLinkJoinSql,
  sessionEvidenceLinkPredicateSql,
} from "./branch-session-identity-sql";

/** The observed-push rung, without materializing the complete Session-link history. */
export type BranchOwnerEvidence = {
  observedUserId: string | null;
  observedAvailability: BranchIdentityAvailability;
};

type OwnerRow = BranchOwnerEvidence & { branchId: string };
type CommentRow = { branchId: string; authorId: string };

/** Reuse the observed-push Owner rung and bounded linked-comment windows for the batch reader. */
export async function readBatchSessionLinkEvidence(
  db: Pick<PrismaClient, "$queryRaw">,
  organizationId: string,
  branchIds: readonly string[],
  commentLimit: number
) {
  const [owners, comments] = await Promise.all([
    db.$queryRaw<OwnerRow[]>(Prisma.sql`
      SELECT a.id AS "branchId",
        split_part(branch_owner_identity.observed_owner_key, ':', 2) AS "observedUserId",
        branch_owner_identity.observed_owner_availability AS "observedAvailability"
      FROM artifacts a JOIN branch_detail b ON b.artifact_id = a.id AND b.organization_id = a.organization_id
      ${branchOwnerIdentityLateralSql()}
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.id = ANY(${[...branchIds]}::uuid[])
        AND a.type = ${ArtifactType.Branch}::"ArtifactType"
    `),
    db.$queryRaw<CommentRow[]>(Prisma.sql`
      WITH ranked AS (
        SELECT a.id AS "branchId", c.author_id AS "authorId",
          row_number() OVER (PARTITION BY a.id ORDER BY c.created_at, c.id) AS row_rank
        FROM artifacts a JOIN branch_detail b ON b.artifact_id = a.id AND b.organization_id = a.organization_id
        JOIN comment_threads t ON t.organization_id = a.organization_id
          AND t.source IN (${ThreadSource.Native}::"ThreadSource", ${ThreadSource.Liveblocks}::"ThreadSource")
        JOIN comments c ON c.thread_id = t.id AND c.deleted_at IS NULL
        WHERE a.organization_id = ${organizationId}::uuid
          AND a.id = ANY(${[...branchIds]}::uuid[])
          AND a.type = ${ArtifactType.Branch}::"ArtifactType"
          AND t.artifact_id IN (
            SELECT al.source_id ${sessionEvidenceLinkJoinSql()}
            WHERE ${sessionEvidenceLinkPredicateSql()}
          )
      )
      SELECT "branchId", "authorId" FROM ranked WHERE row_rank <= ${commentLimit + 1}
      ORDER BY "branchId", row_rank
    `),
  ]);
  const commentsByBranch = new Map<string, CommentRow[]>();
  for (const row of comments) {
    const group = commentsByBranch.get(row.branchId) ?? [];
    group.push(row);
    commentsByBranch.set(row.branchId, group);
  }
  return {
    ownersByBranch: new Map(
      owners.map((row) => [
        row.branchId,
        {
          observedUserId: row.observedUserId,
          observedAvailability: row.observedAvailability,
        },
      ])
    ),
    commentsByBranch,
  };
}
