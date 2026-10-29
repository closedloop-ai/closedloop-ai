import { ArtifactType } from "@repo/api/src/types/artifact";
import { SessionMetadataActivityField } from "@repo/api/src/types/artifact-activity";
import type { SessionStatus } from "@repo/api/src/types/session-status";
import { Prisma, type TransactionClient } from "@repo/database";
import {
  captureSystemSessionMetadataChange,
  captureSystemSessionStatusChange,
} from "@/lib/artifact-activity-recording";

export type SessionMetadataWriteSnapshot = {
  artifactId: string;
  status: string;
  projectId: string | null;
  afterStatus: string | null;
  afterProjectId: string | null;
};

/** Lock and write grouping fields together so receipts observe the actual transition. */
export async function writeSessionArtifactMetadata(
  tx: TransactionClient,
  input: {
    organizationId: string;
    artifactId: string | null;
    status: SessionStatus;
    projectId: string | null;
    name: string | null;
  }
): Promise<SessionMetadataWriteSnapshot | null> {
  if (input.artifactId === null) {
    return null;
  }
  const [row] = await tx.$queryRaw<SessionMetadataWriteSnapshot[]>(Prisma.sql`
    WITH prior AS MATERIALIZED (
      SELECT id, status, project_id
      FROM artifacts
      WHERE id = ${input.artifactId}::uuid
        AND organization_id = ${input.organizationId}::uuid
        AND type = ${ArtifactType.Session}::"ArtifactType"
      FOR NO KEY UPDATE
    ), written AS (
      UPDATE artifacts a
      SET status = ${input.status}, name = ${input.name},
          -- ISS-10995 (operator ruling 2026-10-12): FILL-ONLY. The sync files a
          -- session the first time it resolves a project and never re-files it,
          -- so a project set on the Details row survives every later sync. The
          -- operand order IS the behaviour: reversed, lineage wins.
          project_id = COALESCE(a.project_id, ${input.projectId}::uuid),
          updated_at = ${new Date()}
      FROM prior
      WHERE a.id = prior.id
      RETURNING a.id, a.status, a.project_id
    )
    SELECT prior.id AS "artifactId", prior.status,
      prior.project_id AS "projectId", written.status AS "afterStatus",
      written.project_id AS "afterProjectId"
    FROM prior LEFT JOIN written ON written.id = prior.id
  `);
  if (row && row.afterStatus === null) {
    throw new Error("ingested Session metadata missing after its write");
  }
  return row ?? null;
}

/** Record the locked write's net System transitions on the same transaction. */
export async function captureCommittedSessionMetadata(
  tx: TransactionClient,
  organizationId: string,
  snapshot: SessionMetadataWriteSnapshot | null,
  artifactId: string
): Promise<void> {
  if (!snapshot || snapshot.artifactId !== artifactId) {
    return;
  }
  if (snapshot.afterStatus === null) {
    throw new Error("ingested Session metadata missing after its write");
  }
  await captureSystemSessionStatusChange({
    tx,
    organizationId,
    artifactId,
    before: snapshot.status,
    after: snapshot.afterStatus,
  });
  await captureSystemSessionMetadataChange({
    tx,
    organizationId,
    artifactId,
    field: SessionMetadataActivityField.ProjectId,
    before: snapshot.projectId,
    after: snapshot.afterProjectId,
  });
}
