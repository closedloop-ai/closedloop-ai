import { ArtifactType } from "@repo/api/src/types/artifact";
import { Prisma, type PrismaClient } from "@repo/database";

/** A measured PR author row; absent identity remains a coverage gap. */
export type PullRequestAuthorRow = {
  id: string;
  branchArtifactId: string;
  authorProviderUserId: string | null;
  authorActorType: string | null;
  authorLogin: string | null;
};

/** Persisted push and its current Branch coordinate, before person admission. */
export type PushContributionRow = {
  id: string;
  branchArtifactId: string;
  repositoryFullName: string;
  refName: string;
  providerUserId: string;
  actorType: string;
  beforeSha: string;
  afterSha: string;
  branch: { repositoryFullName: string; branchName: string };
};

type WindowInput = {
  organizationId: string;
  branchIds: readonly string[];
  limit: number;
};
type WindowClient = Pick<PrismaClient, "$queryRaw">;

/** Saturated pages admit at most limit+1 rows per Branch in the database. */
export function readPullRequestAuthorWindow(
  db: WindowClient,
  input: WindowInput
): Promise<PullRequestAuthorRow[]> {
  return db.$queryRaw<PullRequestAuthorRow[]>(Prisma.sql`
    WITH ranked AS (
      SELECT pr.id, pr.branch_artifact_id AS "branchArtifactId",
        pr.author_provider_user_id AS "authorProviderUserId",
        pr.author_actor_type AS "authorActorType", pr.author_login AS "authorLogin",
        row_number() OVER (PARTITION BY pr.branch_artifact_id ORDER BY pr.number, pr.id) AS row_rank
      FROM pull_request_detail pr
      JOIN artifacts a ON a.id = pr.branch_artifact_id
        AND a.organization_id = ${input.organizationId}::uuid
        AND a.type = ${ArtifactType.Branch}::"ArtifactType"
      WHERE pr.organization_id = ${input.organizationId}::uuid
        AND pr.branch_artifact_id = ANY(${[...input.branchIds]}::uuid[])
    )
    SELECT id, "branchArtifactId", "authorProviderUserId", "authorActorType", "authorLogin"
    FROM ranked WHERE row_rank <= ${input.limit + 1}
    ORDER BY "branchArtifactId", row_rank
  `);
}

/** Seek current-ref receipts in index order; stale coordinates do not consume admission. */
export async function readPushContributionWindow(
  db: WindowClient,
  input: WindowInput
) {
  const [rows, mismatched] = await Promise.all([
    db.$queryRaw<PushContributionRow[]>(Prisma.sql`
      SELECT p.id, p.branch_artifact_id AS "branchArtifactId",
          p.repository_full_name AS "repositoryFullName", p.ref_name AS "refName",
          p.provider_user_id AS "providerUserId", p.actor_type AS "actorType",
          p.before_sha AS "beforeSha", p.after_sha AS "afterSha",
          jsonb_build_object('repositoryFullName', b.repository_full_name, 'branchName', b.branch_name) AS branch
        FROM branch_detail b
        JOIN artifacts a ON a.id = b.artifact_id AND a.organization_id = b.organization_id
          AND a.type = ${ArtifactType.Branch}::"ArtifactType"
        JOIN LATERAL (
          SELECT receipt.* FROM branch_push_contributions receipt
          WHERE receipt.organization_id = b.organization_id
            AND receipt.branch_artifact_id = b.artifact_id
            AND receipt.repository_full_name = b.repository_full_name
            AND receipt.ref_name = b.branch_name
          ORDER BY receipt.observed_at, receipt.id LIMIT ${input.limit + 1}
        ) p ON TRUE
        WHERE b.organization_id = ${input.organizationId}::uuid
          AND b.artifact_id = ANY(${[...input.branchIds]}::uuid[])
      ORDER BY b.artifact_id, p.observed_at, p.id
    `),
    db.$queryRaw<{ branchArtifactId: string }[]>(Prisma.sql`
      SELECT b.artifact_id AS "branchArtifactId" FROM branch_detail b
      WHERE b.organization_id = ${input.organizationId}::uuid
        AND b.artifact_id = ANY(${[...input.branchIds]}::uuid[])
        AND EXISTS (
          SELECT 1 FROM branch_push_contributions p
          WHERE p.organization_id = b.organization_id AND p.branch_artifact_id = b.artifact_id
            AND (p.repository_full_name <> b.repository_full_name OR p.ref_name <> b.branch_name)
        )
    `),
  ]);
  return {
    rows,
    mismatchedBranchIds: new Set(mismatched.map((row) => row.branchArtifactId)),
  };
}
