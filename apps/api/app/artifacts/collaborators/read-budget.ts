import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ArtifactCollaboratorBatchQuery } from "@repo/api/src/types/artifact-collaborators";
import { ThreadSource } from "@repo/api/src/types/comment";
import { Prisma, type TransactionClient } from "@repo/database";
import {
  sessionEvidenceLinkJoinSql,
  sessionEvidenceLinkPredicateSql,
} from "@/app/branches/branch-read-service/branch-session-identity-sql";
import {
  BRANCH_COMMENT_EVIDENCE_MAX_ROWS,
  BRANCH_CONTRIBUTOR_EVIDENCE_MAX_ROWS,
} from "@/app/branches/branch-read-service/identity-evidence-limits";

/** Request bounds protect profile fan-out and serialization without altering per-Branch admission. */
export const COLLABORATOR_READ_MAX_CANDIDATE_ROWS = 50_000;
export const COLLABORATOR_READ_MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

/** Conservative count probes read only capped rows, never comment bodies or profiles. */
export async function collaboratorReadFitsBudget(
  db: Pick<TransactionClient, "$queryRaw">,
  organizationId: string,
  query: ArtifactCollaboratorBatchQuery
): Promise<boolean> {
  const branch = query.artifactType === ArtifactType.Branch;
  const countSql = branch
    ? Prisma.sql`${branchCandidateCountSql()} + ${directCandidateCountSql()}`
    : directCandidateCountSql();
  const [row] = await db.$queryRaw<{ candidateCount: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(${countSql}), 0)::int AS "candidateCount"
    FROM artifacts a
    LEFT JOIN branch_detail b ON b.artifact_id = a.id AND b.organization_id = a.organization_id
    WHERE a.organization_id = ${organizationId}::uuid
      AND a.type = ${query.artifactType}::"ArtifactType"
      AND a.id = ANY(${query.artifactIds}::uuid[])
      ${branch ? Prisma.sql`AND b.artifact_id IS NOT NULL` : Prisma.empty}
  `);
  return (row?.candidateCount ?? 0) <= COLLABORATOR_READ_MAX_CANDIDATE_ROWS;
}

function platformCommentsCountSql(artifactPredicate: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(SELECT count(*) FROM (
    SELECT 1 FROM comments c JOIN comment_threads t ON t.id = c.thread_id
    WHERE t.organization_id = a.organization_id AND c.deleted_at IS NULL
      AND t.source IN (${ThreadSource.Native}::"ThreadSource", ${ThreadSource.Liveblocks}::"ThreadSource")
      AND ${artifactPredicate} LIMIT ${BRANCH_COMMENT_EVIDENCE_MAX_ROWS + 1}
  ) bounded_comments)`;
}

function branchCandidateCountSql(): Prisma.Sql {
  return Prisma.sql`1 +
    (SELECT count(*) FROM (SELECT 1 FROM pull_request_detail pr
      WHERE pr.organization_id = a.organization_id AND pr.branch_artifact_id = a.id
      LIMIT ${BRANCH_CONTRIBUTOR_EVIDENCE_MAX_ROWS + 1}) bounded_authors) +
    (SELECT count(*) FROM (SELECT 1 FROM branch_push_contributions p
      WHERE p.organization_id = a.organization_id AND p.branch_artifact_id = a.id
        AND p.repository_full_name = b.repository_full_name AND p.ref_name = b.branch_name
      LIMIT ${BRANCH_CONTRIBUTOR_EVIDENCE_MAX_ROWS + 1}) bounded_pushes) +
    ${platformCommentsCountSql(Prisma.sql`t.artifact_id = a.id`)} +
    ${platformCommentsCountSql(Prisma.sql`t.artifact_id IN (SELECT al.source_id ${sessionEvidenceLinkJoinSql()} WHERE ${sessionEvidenceLinkPredicateSql()})`)} +
    (SELECT count(*) FROM (SELECT 1 FROM github_comment_projections gcp
      JOIN comments c ON c.id = gcp.comment_id AND c.deleted_at IS NULL
      JOIN github_comment_thread_projections tp ON tp.thread_id = gcp.thread_id AND tp.deleted_at IS NULL
      JOIN pull_request_detail pr ON pr.id = tp.pull_request_detail_id AND pr.branch_artifact_id = a.id AND pr.organization_id = a.organization_id
      WHERE tp.branch_artifact_id = a.id AND gcp.github_deleted_at IS NULL
      LIMIT ${BRANCH_COMMENT_EVIDENCE_MAX_ROWS + 1}) bounded_github_comments)`;
}

function directCandidateCountSql(): Prisma.Sql {
  return Prisma.sql`1 +
    (SELECT count(*) FROM (SELECT 1 FROM comments c JOIN comment_threads t ON t.id = c.thread_id
      WHERE t.organization_id = a.organization_id AND t.artifact_id = a.id AND c.deleted_at IS NULL
      AND t.source IN (${ThreadSource.Native}::"ThreadSource", ${ThreadSource.Liveblocks}::"ThreadSource")
      LIMIT ${COLLABORATOR_READ_MAX_CANDIDATE_ROWS + 1}) direct_comments) +
    (SELECT count(*) FROM (SELECT 1 FROM artifact_activity_events e
      WHERE e.organization_id = a.organization_id AND e.artifact_id = a.id
      LIMIT ${COLLABORATOR_READ_MAX_CANDIDATE_ROWS + 1}) direct_activity) +
    (SELECT count(*) FROM (SELECT 1 FROM document_versions v WHERE v.artifact_id = a.id
      LIMIT ${COLLABORATOR_READ_MAX_CANDIDATE_ROWS + 1}) direct_versions)`;
}
