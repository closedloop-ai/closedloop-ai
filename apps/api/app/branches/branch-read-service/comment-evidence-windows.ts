import { ArtifactType } from "@repo/api/src/types/artifact";
import { ThreadSource } from "@repo/api/src/types/comment";
import { Prisma, type PrismaClient } from "@repo/database";
import type { BranchCommentEvidence } from "./collaborator-projection";

type PlatformCommentRow = { branchId: string; authorId: string };
type GitHubCommentRow = BranchCommentEvidence["githubComments"][number] & {
  branchId: string;
};

export type BranchCommentWindows = {
  branch: Map<string, PlatformCommentRow[]> | null;
  session: Map<string, PlatformCommentRow[]> | null;
  github: Map<string, GitHubCommentRow[]> | null;
};

/** A saturated flat page cannot preserve per-Branch admission; window only the saturated sources. */
export async function readBranchCommentWindows(
  db: Pick<PrismaClient, "$queryRaw">,
  input: {
    organizationId: string;
    branchIds: readonly string[];
    sessionIdsByBranch: ReadonlyMap<string, ReadonlySet<string>>;
    limit: number;
    saturated: { branch: boolean; session: boolean; github: boolean };
  }
): Promise<BranchCommentWindows> {
  const [branch, session, github] = await Promise.all([
    input.saturated.branch ? readPlatformBranchWindow(db, input) : null,
    input.saturated.session ? readLinkedSessionWindow(db, input) : null,
    input.saturated.github ? readGitHubCommentWindow(db, input) : null,
  ]);
  return { branch, session, github };
}

type WindowInput = Parameters<typeof readBranchCommentWindows>[1];

function platformSourceSql(): Prisma.Sql {
  return Prisma.sql`t.source IN (${ThreadSource.Native}::"ThreadSource", ${ThreadSource.Liveblocks}::"ThreadSource")`;
}

async function readPlatformBranchWindow(
  db: Pick<PrismaClient, "$queryRaw">,
  input: WindowInput
): Promise<Map<string, PlatformCommentRow[]>> {
  const rows = await db.$queryRaw<PlatformCommentRow[]>(Prisma.sql`
    WITH ranked AS (
      SELECT t.artifact_id AS "branchId", c.author_id AS "authorId",
        row_number() OVER (PARTITION BY t.artifact_id ORDER BY c.created_at, c.id) AS row_rank
      FROM comments c
      JOIN comment_threads t ON t.id = c.thread_id
      JOIN artifacts a ON a.id = t.artifact_id
        AND a.organization_id = ${input.organizationId}::uuid
        AND a.type = ${ArtifactType.Branch}::"ArtifactType"
      WHERE t.organization_id = ${input.organizationId}::uuid
        AND t.artifact_id = ANY(${[...input.branchIds]}::uuid[])
        AND c.deleted_at IS NULL AND ${platformSourceSql()}
    )
    SELECT "branchId", "authorId" FROM ranked
    WHERE row_rank <= ${input.limit + 1}
    ORDER BY "branchId", row_rank
  `);
  return groupWindowRows(rows);
}

async function readLinkedSessionWindow(
  db: Pick<PrismaClient, "$queryRaw">,
  input: WindowInput
): Promise<Map<string, PlatformCommentRow[]>> {
  const branchIds: string[] = [];
  const sessionIds: string[] = [];
  for (const [branchId, ids] of input.sessionIdsByBranch) {
    for (const sessionId of ids) {
      branchIds.push(branchId);
      sessionIds.push(sessionId);
    }
  }
  const rows = await db.$queryRaw<PlatformCommentRow[]>(Prisma.sql`
    WITH scoped AS (
      SELECT * FROM unnest(${branchIds}::uuid[], ${sessionIds}::uuid[]) AS links(branch_id, session_id)
    ), ranked AS (
      SELECT scoped.branch_id AS "branchId", c.author_id AS "authorId",
        row_number() OVER (PARTITION BY scoped.branch_id ORDER BY c.created_at, c.id) AS row_rank
      FROM scoped
      JOIN comment_threads t ON t.artifact_id = scoped.session_id
      JOIN comments c ON c.thread_id = t.id
      JOIN artifacts session ON session.id = scoped.session_id
        AND session.organization_id = ${input.organizationId}::uuid
        AND session.type = ${ArtifactType.Session}::"ArtifactType"
      JOIN artifacts branch ON branch.id = scoped.branch_id
        AND branch.organization_id = ${input.organizationId}::uuid
        AND branch.type = ${ArtifactType.Branch}::"ArtifactType"
      WHERE t.organization_id = ${input.organizationId}::uuid
        AND c.deleted_at IS NULL AND ${platformSourceSql()}
    )
    SELECT "branchId", "authorId" FROM ranked
    WHERE row_rank <= ${input.limit + 1}
    ORDER BY "branchId", row_rank
  `);
  return groupWindowRows(rows);
}

async function readGitHubCommentWindow(
  db: Pick<PrismaClient, "$queryRaw">,
  input: WindowInput
): Promise<Map<string, GitHubCommentRow[]>> {
  const rows = await db.$queryRaw<GitHubCommentRow[]>(Prisma.sql`
    WITH ranked AS (
      SELECT tp.branch_artifact_id AS "branchId",
        jsonb_build_object(
          'branchArtifactId', tp.branch_artifact_id,
          'pullRequestDetailId', tp.pull_request_detail_id,
          'fetchResultReason', tp.fetch_result_reason
        ) AS "threadProjection",
        CASE WHEN eca.id IS NULL THEN NULL ELSE jsonb_build_object(
          'providerUserId', eca.provider_user_id,
          'providerLogin', eca.provider_login,
          'displayName', eca.display_name,
          'avatarUrl', eca.avatar_url,
          'profileUrl', eca.profile_url,
          'userId', eca.user_id,
          'providerDetail', eca.provider_detail
        ) END AS "externalAuthor",
        row_number() OVER (PARTITION BY tp.branch_artifact_id ORDER BY c.created_at, gcp.comment_id) AS row_rank
      FROM github_comment_projections gcp
      JOIN comments c ON c.id = gcp.comment_id
      JOIN comment_threads t ON t.id = c.thread_id
      JOIN github_comment_thread_projections tp ON tp.thread_id = gcp.thread_id
      JOIN pull_request_detail pr ON pr.id = tp.pull_request_detail_id
        AND pr.branch_artifact_id = tp.branch_artifact_id
        AND pr.organization_id = ${input.organizationId}::uuid
      LEFT JOIN external_comment_authors eca ON eca.id = gcp.external_author_id
        AND eca.organization_id = ${input.organizationId}::uuid
      WHERE tp.branch_artifact_id = ANY(${[...input.branchIds]}::uuid[])
        AND t.organization_id = ${input.organizationId}::uuid
        AND gcp.github_deleted_at IS NULL AND c.deleted_at IS NULL AND tp.deleted_at IS NULL
    )
    SELECT "branchId", "threadProjection", "externalAuthor" FROM ranked
    WHERE row_rank <= ${input.limit + 1}
    ORDER BY "branchId", row_rank
  `);
  return groupWindowRows(rows);
}

function groupWindowRows<TRow extends { branchId: string }>(
  rows: readonly TRow[]
): Map<string, TRow[]> {
  const grouped = new Map<string, TRow[]>();
  for (const row of rows) {
    let group = grouped.get(row.branchId);
    if (!group) {
      group = [];
      grouped.set(row.branchId, group);
    }
    group.push(row);
  }
  return grouped;
}
