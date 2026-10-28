import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { Prisma, type PrismaClient } from "@repo/database";

const MAX_EDITOR_IDS_PER_SESSION = 1000;

/** Known account IDs; absent history, unresolved actors and caps leave edits incomplete. */
export type SessionCollaboratorEvidence = {
  ownerId: string | null;
  editorIds: string[];
  editorAvailability: BranchIdentityAvailability;
};

type EditorRow = {
  artifactId: string;
  userId: string | null;
  rowRank: number;
};

/**
 * Read org-owned Session people; a missing creation marker leaves historical
 * editor coverage incomplete even when no retained edit receipt exists.
 * API/MCP activity qualifies when its actor ID resolves to an org user.
 */
export async function readSessionCollaboratorEvidence(
  db: Pick<PrismaClient, "artifact" | "$queryRaw">,
  organizationId: string,
  artifactIds: readonly string[]
): Promise<Map<string, SessionCollaboratorEvidence>> {
  if (artifactIds.length === 0) {
    return new Map();
  }
  const sessions = await db.artifact.findMany({
    where: {
      id: { in: [...artifactIds] },
      organizationId,
      type: ArtifactType.Session,
    },
    select: {
      id: true,
      createdById: true,
      session: {
        select: { metadataActivityCoverageStartedAt: true },
      },
    },
  });
  const result = new Map<string, SessionCollaboratorEvidence>(
    sessions.map((session) => [
      session.id,
      {
        // ISS-12251 D-4: the `owner` collaborator source's person is the
        // session's creator.
        ownerId: session.createdById,
        editorIds: [],
        editorAvailability: session.session?.metadataActivityCoverageStartedAt
          ? BranchIdentityAvailability.Complete
          : BranchIdentityAvailability.Incomplete,
      },
    ])
  );
  if (result.size === 0) {
    return result;
  }

  const idSql = Prisma.join(
    [...result.keys()].map((id) => Prisma.sql`${id}::uuid`)
  );
  const rows = await db.$queryRaw<EditorRow[]>(Prisma.sql`
    WITH eligible AS (
      SELECT DISTINCT e.artifact_id, e.actor_id
      FROM artifact_activity_events e
      WHERE e.organization_id = ${organizationId}::uuid
        AND e.artifact_id IN (${idSql})
        AND e.actor_type IN (
          ${ArtifactActivityActorType.User},
          ${ArtifactActivityActorType.Agent}
        )
        AND e.actor_id IS NOT NULL
        AND (
          e.action = ${ArtifactActivityAction.StatusChange}
          OR (
            e.action = ${ArtifactActivityAction.FieldChange}
            AND e.after ->> 'field' IN (
              ${SessionMetadataActivityField.Priority},
              ${SessionMetadataActivityField.ProjectId},
              ${SessionMetadataActivityField.Tag},
              ${SessionMetadataActivityField.Name}
            )
          )
          OR (
            e.action = ${ArtifactActivityAction.Assignment}
            -- ISS-12251: owner receipts are filed under assigneeId; rows
            -- written before that carry ownerUserId.
            AND e.after ->> 'field' IN (
              ${SessionMetadataActivityField.AssigneeId},
              ${SessionMetadataActivityField.OwnerUserId}
            )
          )
        )
    ), ranked AS (
      SELECT artifact_id, actor_id,
        row_number() OVER (PARTITION BY artifact_id ORDER BY actor_id) AS row_rank
      FROM eligible
    )
    SELECT ranked.artifact_id AS "artifactId",
      u.id AS "userId",
      ranked.row_rank::int AS "rowRank"
    FROM ranked
    LEFT JOIN users u
      ON u.organization_id = ${organizationId}::uuid
      AND u.id::text = ranked.actor_id
    WHERE ranked.row_rank <= ${MAX_EDITOR_IDS_PER_SESSION + 1}
  `);
  for (const row of rows) {
    const evidence = result.get(row.artifactId);
    if (!evidence) {
      continue;
    }
    if (row.rowRank > MAX_EDITOR_IDS_PER_SESSION || !row.userId) {
      evidence.editorAvailability = BranchIdentityAvailability.Incomplete;
      continue;
    }
    evidence.editorIds.push(row.userId);
  }
  return result;
}
