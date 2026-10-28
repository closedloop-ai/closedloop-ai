import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";

/**
 * Seeders for the DB-backed Related Sessions suites. Every write goes through
 * `withDb`, so inside `autoRollbackTransaction` it joins the ambient
 * transaction and rolls back with it.
 */
export function createDocumentArtifact(
  organizationId: string,
  name: string
): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.DOCUMENT,
        name,
        status: DocumentStatus.Draft,
      },
      select: { id: true },
    });
    return artifact.id;
  });
}

export function createRelatedSessionLink(params: {
  organizationId: string;
  sourceId: string;
  targetId: string;
  contributedAt: string;
  branchParticipation?: string;
  metadata?: unknown;
}): Promise<void> {
  return withDb(async (db) => {
    await db.artifactLink.create({
      data: {
        organizationId: params.organizationId,
        sourceId: params.sourceId,
        targetId: params.targetId,
        linkType: LinkType.RelatesTo,
        branchParticipation: params.branchParticipation,
        lastContributedAt: new Date(params.contributedAt),
        metadata: params.metadata ?? { relation: ArtifactRefRelation.Created },
      },
      select: { id: true },
    });
  });
}
