import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import {
  CollaboratorArtifactType,
  type DirectArtifactCollaborators,
  DirectCollaboratorSource,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchIdentityAvailability,
  type BranchPersonCandidate,
  BranchPersonProvider,
  projectArtifactPeople,
  type SourceCollaborators,
} from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import { Prisma, type TransactionClient } from "@repo/database";
import { isGitHubShadowClerkId } from "@/app/comments/github-shadow-identity";
import { displayUserName } from "@/lib/user-display-name";

/** One direct participation definition for every artifact kind. No comment bodies read. */
export const directParticipationService = {
  async read(
    db: Pick<TransactionClient, "$queryRaw">,
    organizationId: string,
    artifactType: CollaboratorArtifactType,
    artifactIds: readonly string[],
    /**
     * Complete native/Liveblocks comment sets the caller already read, keyed by
     * artifact. Those artifacts are not scanned again; the rest still are.
     */
    knownComments?: ReadonlyMap<string, readonly KnownThreadComment[]>
  ): Promise<DirectParticipationEntry[]> {
    if (!artifactIds.length) {
      return [];
    }
    // Aggregate counts and distinct actor IDs in SQL. Admission bounds evidence rows;
    // arrays are lossless and profiles are projected once, after deduplication.
    const rows = await db.$queryRaw<DirectParticipationRow[]>(Prisma.sql`
      WITH owned AS (
        SELECT a.id, a.created_by_id,
          ${interactionCoverageSql(organizationId, artifactType)} AS has_interaction_coverage
        FROM artifacts a
        WHERE a.organization_id = ${organizationId}::uuid
          AND a.type = ${artifactType}::"ArtifactType"
          AND a.id = ANY(${artifactIds}::uuid[])
          -- ISS-11589: a Branch's deletion decides only whether it is active, so
          -- this existence check must not screen on it. Screening dropped the
          -- entry, and readBatch then dropped the whole row, so a listed deleted
          -- Branch lost every collaborator on its header and details.
          AND (${artifactType}::"ArtifactType" <> ${ArtifactType.Branch}::"ArtifactType" OR EXISTS (
            SELECT 1 FROM branch_detail b WHERE b.artifact_id = a.id AND b.organization_id = ${organizationId}::uuid))
      ), direct_comments AS (
        ${directCommentsSql(organizationId, artifactIds, knownComments)}
      ), interactions AS (
        SELECT e.artifact_id, e.actor_id FROM artifact_activity_events e
        JOIN owned a ON a.id = e.artifact_id
        WHERE e.organization_id = ${organizationId}::uuid
          AND e.actor_type IN (${ArtifactActivityActorType.User}, ${ArtifactActivityActorType.Agent})
          AND e.actor_id IS NOT NULL
        UNION
        SELECT v.artifact_id, v.created_by_id::text FROM document_versions v
        JOIN owned a ON a.id = v.artifact_id WHERE v.created_by_id IS NOT NULL
      ), evidence AS (
        SELECT id AS artifact_id, created_by_id::text AS actor_id, ${DirectCollaboratorSource.Creator} AS source FROM owned WHERE created_by_id IS NOT NULL
        UNION SELECT artifact_id, actor_id, ${DirectCollaboratorSource.Interactions} FROM interactions
        UNION SELECT artifact_id, author_id::text, ${DirectCollaboratorSource.Comments} FROM direct_comments
      ), comment_counts AS (
        SELECT artifact_id, COUNT(DISTINCT thread_id)::int AS comment_count
        FROM direct_comments GROUP BY artifact_id
      )
      SELECT a.id AS "artifactId", e.source, e.actor_id AS "actorId",
        u.id AS "userId", u.clerk_id AS "clerkId", u.email,
        u.first_name AS "firstName", u.last_name AS "lastName", u.avatar_url AS "avatarUrl",
        COALESCE(cc.comment_count, 0) AS "commentCount",
        a.has_interaction_coverage AS "hasInteractionCoverage"
      FROM owned a
      LEFT JOIN comment_counts cc ON cc.artifact_id = a.id
      LEFT JOIN evidence e ON e.artifact_id = a.id
      LEFT JOIN users u ON u.id = CASE WHEN pg_input_is_valid(e.actor_id, 'uuid') THEN e.actor_id::uuid END
        AND u.organization_id = ${organizationId}::uuid
      ORDER BY a.id, e.source, e.actor_id
    `);
    return projectRows(rows, artifactType);
  },
};

type DirectParticipationRow = {
  artifactId: string;
  source: DirectCollaboratorSource | null;
  actorId: string | null;
  userId: string | null;
  clerkId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  commentCount: number;
  hasInteractionCoverage: boolean;
};

function projectRows(
  rows: readonly DirectParticipationRow[],
  artifactType: CollaboratorArtifactType
): DirectParticipationEntry[] {
  const entries = new Map<
    string,
    {
      row: DirectParticipationRow;
      candidates: BranchPersonCandidate[];
      sources: Record<DirectCollaboratorSource, BranchIdentityAvailability>;
    }
  >();
  for (const row of rows) {
    let entry = entries.get(row.artifactId);
    if (!entry) {
      entry = {
        row,
        candidates: [],
        sources: {
          [DirectCollaboratorSource.Creator]:
            BranchIdentityAvailability.Complete,
          [DirectCollaboratorSource.Interactions]: row.hasInteractionCoverage
            ? BranchIdentityAvailability.Complete
            : BranchIdentityAvailability.Incomplete,
          [DirectCollaboratorSource.Comments]:
            BranchIdentityAvailability.Complete,
        },
      };
      entries.set(row.artifactId, entry);
    }
    if (!row.source) {
      continue;
    }
    if (
      !(row.userId && row.email && row.clerkId) ||
      isGitHubShadowClerkId(row.clerkId)
    ) {
      entry.sources[row.source] = BranchIdentityAvailability.Incomplete;
      entry.candidates.push({});
    } else {
      entry.candidates.push({
        person: {
          provider: BranchPersonProvider.ClosedLoop,
          id: row.userId,
          userId: row.userId,
          displayName: displayUserName({
            email: row.email,
            firstName: row.firstName,
            lastName: row.lastName,
          }),
          ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
        },
      });
    }
  }
  return [...entries.values()].map(
    ({ row, candidates, sources }): DirectParticipationEntry => ({
      artifactId: row.artifactId,
      artifactType,
      commentCount: row.commentCount,
      collaborators: projectArtifactPeople(candidates, sources),
    })
  );
}

export type DirectParticipationEntry = {
  artifactId: string;
  artifactType: CollaboratorArtifactType;
  commentCount: number;
  collaborators: DirectArtifactCollaborators;
};

export function mergeDirectArtifactPeople<TSource extends string>(
  extended: SourceCollaborators<TSource>,
  direct: DirectParticipationEntry["collaborators"]
): SourceCollaborators<TSource> {
  const candidates = [...extended.people, ...direct.people].map((person) => ({
    person,
    actorType: person.actorType,
  }));
  const projected = projectArtifactPeople(candidates, {
    ...extended.sources,
    ...direct.sources,
  });
  if (
    extended.availability === BranchIdentityAvailability.Incomplete ||
    direct.availability === BranchIdentityAvailability.Incomplete
  ) {
    projected.availability = BranchIdentityAvailability.Incomplete;
  }
  return projected;
}

/**
 * Proof that interaction capture covers the artifact's whole life. Documents carry
 * a creation event (written only by POST /documents); Sessions stamp
 * `metadata_activity_coverage_started_at` at create, the marker Session metadata
 * edits already use. No Branch or Deployment create path writes either, and
 * neither carried an interaction source before direct participation, so they are
 * not gated on one.
 */
function interactionCoverageSql(
  organizationId: string,
  artifactType: CollaboratorArtifactType
): Prisma.Sql {
  const coverage: Record<CollaboratorArtifactType, Prisma.Sql> = {
    [CollaboratorArtifactType.Document]: Prisma.sql`EXISTS (SELECT 1 FROM artifact_activity_events marker WHERE marker.organization_id = ${organizationId}::uuid AND marker.artifact_id = a.id AND marker.action = ${ArtifactActivityAction.Creation})`,
    [CollaboratorArtifactType.Session]: Prisma.sql`EXISTS (SELECT 1 FROM session_detail s WHERE s.artifact_id = a.id AND s.metadata_activity_coverage_started_at IS NOT NULL)`,
    [CollaboratorArtifactType.Branch]: Prisma.sql`TRUE`,
    [CollaboratorArtifactType.Deployment]: Prisma.sql`TRUE`,
  };
  return coverage[artifactType];
}

export type KnownThreadComment = { threadId: string; authorId: string };

function directCommentsSql(
  organizationId: string,
  artifactIds: readonly string[],
  knownComments: ReadonlyMap<string, readonly KnownThreadComment[]> | undefined
): Prisma.Sql {
  const knownArtifactIds = artifactIds.filter((id) => knownComments?.has(id));
  const known = knownArtifactIds.flatMap((artifactId) =>
    (knownComments?.get(artifactId) ?? []).map((comment) => ({
      artifactId,
      ...comment,
    }))
  );
  const knownSql = Prisma.sql`
    SELECT k.artifact_id, k.thread_id, k.author_id
    FROM unnest(
      ${known.map((row) => row.artifactId)}::uuid[],
      ${known.map((row) => row.threadId)}::uuid[],
      ${known.map((row) => row.authorId)}::uuid[]
    ) AS k(artifact_id, thread_id, author_id)
    JOIN owned a ON a.id = k.artifact_id`;
  if (knownArtifactIds.length === artifactIds.length) {
    return knownSql;
  }
  const scannedSql = Prisma.sql`
    SELECT t.artifact_id, t.id AS thread_id, c.author_id FROM comment_threads t
    JOIN owned a ON a.id = t.artifact_id
    JOIN comments c ON c.thread_id = t.id AND c.deleted_at IS NULL
    WHERE t.organization_id = ${organizationId}::uuid
      AND t.source IN (${ThreadSource.Native}::"ThreadSource", ${ThreadSource.Liveblocks}::"ThreadSource")`;
  if (knownArtifactIds.length === 0) {
    return scannedSql;
  }
  return Prisma.sql`${scannedSql}
      AND NOT (t.artifact_id = ANY(${knownArtifactIds}::uuid[]))
    UNION ALL ${knownSql}`;
}
