import { ArtifactType } from "@repo/api/src/types/artifact";
import { GitHubInstallationStatus, Prisma } from "@repo/database";

/** Interleave bounded never-attempted and due lanes so new Branches cannot starve retries. */
export function branchPushBackfillQueueSql(input: {
  organizationId?: string;
  limit: number;
  retryHours: number;
}): Prisma.Sql {
  const scope = Prisma.sql`
    FROM branch_detail b
    JOIN artifacts a ON a.id = b.artifact_id
    JOIN github_installation_repositories r ON r.id = b.repository_id
    JOIN github_installations i ON i.id = r.installation_id
      AND i.organization_id = b.organization_id
    WHERE a.type = ${ArtifactType.Branch}::"ArtifactType"
      AND (b.first_pushed_at IS NOT NULL OR EXISTS (
        SELECT 1 FROM pull_request_detail pr
        WHERE pr.organization_id = b.organization_id
          AND pr.branch_artifact_id = b.artifact_id
      ))
      AND b.deleted_at IS NULL AND r.removed_at IS NULL
      AND i.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
      ${input.organizationId ? Prisma.sql`AND b.organization_id = ${input.organizationId}::uuid` : Prisma.empty}
  `;
  // Each lane matches the existing (last attempt, artifact ID) index; only 2*limit rows sort.
  return Prisma.sql`
    WITH never_attempted AS (
      SELECT b.organization_id, b.artifact_id, b.push_coverage_last_attempt_at,
        false AS attempted
      ${scope}
        AND b.push_coverage_last_attempt_at IS NULL
      ORDER BY b.artifact_id ASC LIMIT ${input.limit}
    ), due AS (
      SELECT b.organization_id, b.artifact_id, b.push_coverage_last_attempt_at,
        true AS attempted
      ${scope}
        AND b.push_coverage_last_attempt_at <
          now() - (${input.retryHours}::int * INTERVAL '1 hour')
      ORDER BY b.push_coverage_last_attempt_at ASC, b.artifact_id ASC
      LIMIT ${input.limit}
    ), candidates AS (
      SELECT * FROM never_attempted UNION ALL SELECT * FROM due
    )
    SELECT organization_id AS "organizationId", artifact_id AS "branchArtifactId"
    FROM candidates
    ORDER BY row_number() OVER (
      PARTITION BY attempted ORDER BY push_coverage_last_attempt_at ASC, artifact_id ASC
    ), attempted ASC
    LIMIT ${input.limit}
  `;
}
