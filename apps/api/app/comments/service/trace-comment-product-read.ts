import "server-only";

import { decodeBranchId } from "@repo/api/src/types/branch";
import {
  CommentTargetType,
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_METADATA_KIND,
} from "@repo/api/src/types/comment";
import { ArtifactType, Prisma, type PrismaClient } from "@repo/database";
import { cloudBranchProductEligibilitySql } from "@/app/branches/cloud-branch-eligibility";
import { isUuid } from "@/lib/is-uuid";

type TraceCommentProductReadClient = Pick<
  PrismaClient,
  "$queryRaw" | "branchDetail"
>;

export type AggregateTraceCommentFilters = {
  resolved?: boolean;
  targetType?: CommentTargetType;
  authorId?: string;
  sessionId?: string;
};

/** Build the defensive ORM hydration filter for an aggregate candidate page. */
export function buildAggregateTraceCommentWhere(
  organizationId: string,
  filters: AggregateTraceCommentFilters
): Prisma.CommentThreadWhereInput {
  const metadataFilters: Prisma.CommentThreadWhereInput[] = [
    { metadata: { path: ["kind"], equals: TRACE_COMMENT_METADATA_KIND } },
  ];
  if (filters.targetType) {
    metadataFilters.push({
      metadata: { path: ["targetType"], equals: filters.targetType },
    });
  }
  return {
    organizationId,
    source: ThreadSource.Native,
    comments: { some: { deletedAt: null } },
    ...(filters.resolved === undefined
      ? {}
      : {
          status: filters.resolved ? ThreadStatus.Resolved : ThreadStatus.Open,
        }),
    ...(filters.authorId ? { createdById: filters.authorId } : {}),
    ...(filters.sessionId ? { artifactId: filters.sessionId } : {}),
    AND: metadataFilters,
  };
}

/** Resolve one organization-owned Branch target inside its Product read snapshot. */
export async function resolveProductBranchArtifactId(
  db: TraceCommentProductReadClient,
  input: {
    organizationId: string;
    targetId: string;
  }
): Promise<string | null> {
  // ISS-11190: `artifact_id` is `@db.Uuid` and Postgres raises on a non-UUID,
  // so an `encodeBranchId` id must skip this probe to reach `decodeBranchId`.
  const byArtifactId = isUuid(input.targetId)
    ? await db.branchDetail.findFirst({
        where: {
          artifactId: input.targetId,
          deletedAt: null,
          artifact: {
            is: {
              organizationId: input.organizationId,
              type: ArtifactType.BRANCH,
            },
          },
        },
        select: { artifactId: true },
      })
    : null;
  if (byArtifactId) {
    return byArtifactId.artifactId;
  }

  const decoded = decodeBranchId(input.targetId);
  const branch = await db.branchDetail.findFirst({
    where: {
      branchName: decoded.branchName,
      deletedAt: null,
      ...(decoded.repoFullName
        ? { repository: { is: { fullName: decoded.repoFullName } } }
        : {}),
      artifact: {
        is: {
          organizationId: input.organizationId,
          type: ArtifactType.BRANCH,
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { artifactId: "desc" }],
    select: { artifactId: true },
  });
  return branch?.artifactId ?? null;
}

/** Select one eligible aggregate page and exact total on one MVCC snapshot. */
export async function getAggregateTraceCommentCandidatePage(
  db: TraceCommentProductReadClient,
  organizationId: string,
  filters: AggregateTraceCommentFilters,
  limit: number,
  offset: number
): Promise<{ ids: string[]; total: number }> {
  const predicates = aggregateTraceCommentPredicates(organizationId, filters);
  const rows = await db.$queryRaw<AggregateTraceCommentCandidateRow[]>(
    Prisma.sql`
      WITH candidates AS (
        SELECT thread.id, thread.created_at
        FROM comment_threads thread
        INNER JOIN artifacts a
          ON a.id = thread.artifact_id
          AND a.organization_id = thread.organization_id
        LEFT JOIN session_detail session
          ON session.artifact_id = a.id
        LEFT JOIN branch_detail b
          ON b.artifact_id = a.id
        WHERE ${Prisma.join(predicates, " AND ")}
      ), page_candidates AS (
        SELECT candidate.id, candidate.created_at
        FROM candidates candidate
        ORDER BY candidate.created_at DESC, candidate.id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      )
      SELECT page.id, candidate_count.count
      FROM (SELECT COUNT(*)::bigint AS count FROM candidates) candidate_count
      LEFT JOIN page_candidates page ON TRUE
      ORDER BY page.created_at DESC, page.id DESC
    `
  );
  return {
    ids: rows.flatMap((row) => (row.id ? [row.id] : [])),
    total: Number(rows[0]?.count ?? 0),
  };
}

/** Recheck all Branch targets after hydration/projection without N+1 reads. */
export async function getEligibleProductBranchIds(
  db: TraceCommentProductReadClient,
  organizationId: string,
  branchIds: readonly string[]
): Promise<ReadonlySet<string>> {
  const eligibleIds = new Set<string>();
  const distinctIds = [...new Set(branchIds)];
  for (const ids of chunkValues(
    distinctIds,
    TRACE_COMMENT_BRANCH_GATE_BATCH_SIZE
  )) {
    const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT a.id
      FROM artifacts a
      INNER JOIN branch_detail b ON b.artifact_id = a.id
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        AND b.deleted_at IS NULL
        AND a.id IN (${Prisma.join(
          ids.map((branchId) => Prisma.sql`${branchId}::uuid`)
        )})
        AND ${cloudBranchProductEligibilitySql()}
    `);
    for (const row of rows) {
      eligibleIds.add(row.id);
    }
  }
  return eligibleIds;
}

function aggregateTraceCommentPredicates(
  organizationId: string,
  filters: AggregateTraceCommentFilters
): Prisma.Sql[] {
  const predicates = [
    Prisma.sql`thread.organization_id = ${organizationId}::uuid`,
    Prisma.sql`thread.source = ${ThreadSource.Native}::"ThreadSource"`,
    Prisma.sql`thread.metadata->>'kind' = ${TRACE_COMMENT_METADATA_KIND}`,
    Prisma.sql`EXISTS (
      SELECT 1 FROM comments comment
      WHERE comment.thread_id = thread.id AND comment.deleted_at IS NULL
    )`,
    Prisma.sql`(
      (
        thread.metadata->>'targetType' = ${CommentTargetType.Session}
        AND a.type = ${ArtifactType.SESSION}::"ArtifactType"
        AND session.artifact_id IS NOT NULL
      ) OR (
        thread.metadata->>'targetType' = ${CommentTargetType.Branch}
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        AND b.deleted_at IS NULL
        AND ${cloudBranchProductEligibilitySql()}
      )
    )`,
  ];
  if (filters.resolved !== undefined) {
    predicates.push(
      Prisma.sql`thread.status = ${
        filters.resolved ? ThreadStatus.Resolved : ThreadStatus.Open
      }::"ThreadStatus"`
    );
  }
  if (filters.targetType) {
    predicates.push(
      Prisma.sql`thread.metadata->>'targetType' = ${filters.targetType}`
    );
  }
  if (filters.authorId) {
    predicates.push(
      Prisma.sql`thread.created_by_id = ${filters.authorId}::uuid`
    );
  }
  if (filters.sessionId) {
    predicates.push(
      Prisma.sql`thread.artifact_id = ${filters.sessionId}::uuid`
    );
  }
  return predicates;
}

function chunkValues<Value>(values: Value[], size: number): Value[][] {
  const chunks: Value[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

type AggregateTraceCommentCandidateRow = {
  id: string | null;
  count: bigint | number | string;
};

export const TRACE_COMMENT_BRANCH_GATE_BATCH_SIZE = 500;
