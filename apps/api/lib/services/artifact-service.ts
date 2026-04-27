import { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { type Artifact, ArtifactType, withDb } from "@repo/database";

/**
 * Read-only cross-type artifact helpers (Chunk 2a of PLN-321).
 *
 * Callers flip to this service progressively during Chunk 2d. Until then the
 * rows are populated by the dual-write in `artifact-sync.ts`, so reads here
 * are guaranteed consistent with the legacy `documents` shape for DOCUMENT
 * artifacts. PR/deployment artifacts arrive in Chunk 2b.
 */
export const artifactService = {
  /**
   * Find a single artifact by id within an organization.
   */
  findById(id: string, organizationId: string): Promise<Artifact | null> {
    return withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
      })
    );
  },

  /**
   * List artifacts within an organization, optionally scoped to a project,
   * workstream, type, or assignee. Sentinel projects are filtered out so
   * templates don't leak into user-facing listings.
   */
  list(options: {
    organizationId: string;
    projectId?: string;
    workstreamId?: string;
    type?: ArtifactType;
    assigneeId?: string;
  }): Promise<Artifact[]> {
    const { organizationId, projectId, workstreamId, type, assigneeId } =
      options;

    return withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          ...(projectId ? { projectId } : {}),
          ...(workstreamId ? { workstreamId } : {}),
          ...(type ? { type } : {}),
          ...(assigneeId ? { assigneeId } : {}),
          subtype: { not: ArtifactSubtype.Template },
        },
        orderBy: { createdAt: "desc" },
      })
    );
  },

  /**
   * List templates (DOCUMENT artifacts that live on the sentinel project) for
   * an organization.
   */
  listTemplates(organizationId: string): Promise<Artifact[]> {
    return withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.Template,
        },
        orderBy: { createdAt: "desc" },
      })
    );
  },

  /**
   * Fetch the outbound links (this artifact is the source) for a given artifact.
   */
  findSourceLinks(artifactId: string, organizationId: string) {
    return withDb((db) =>
      db.artifactLink.findMany({
        where: { sourceId: artifactId, organizationId },
      })
    );
  },

  /**
   * Fetch the inbound links (this artifact is the target) for a given artifact.
   */
  findTargetLinks(artifactId: string, organizationId: string) {
    return withDb((db) =>
      db.artifactLink.findMany({
        where: { targetId: artifactId, organizationId },
      })
    );
  },
};
