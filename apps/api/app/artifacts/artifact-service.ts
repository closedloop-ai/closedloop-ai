import { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { type Artifact, type ArtifactType, withDb } from "@repo/database";

/**
 * Cross-type artifact reads. Owns the general/CRUD surface that does not
 * depend on a particular detail row (PullRequestDetail / DeploymentDetail).
 *
 * Type-specific operations live in sibling services (`branchService`,
 * `deploymentService`); per-type detail joins live in `detail-service.ts`.
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
   * Find a bounded set of artifacts by id within an organization.
   */
  findByIds(
    ids: readonly string[],
    organizationId: string
  ): Promise<Pick<Artifact, "id" | "type">[]> {
    const artifactIds = [...new Set(ids)];
    if (artifactIds.length === 0) {
      return Promise.resolve([]);
    }

    return withDb((db) =>
      db.artifact.findMany({
        where: {
          id: { in: artifactIds },
          organizationId,
        },
        select: {
          id: true,
          type: true,
        },
      })
    );
  },

  /**
   * List artifacts within an organization, optionally scoped to a project,
   * type, or assignee. Sentinel projects are filtered out so templates don't
   * leak into user-facing listings.
   */
  list(options: {
    organizationId: string;
    projectId?: string;
    type?: ArtifactType;
    assigneeId?: string;
  }): Promise<Artifact[]> {
    const { organizationId, projectId, type, assigneeId } = options;

    return withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          ...(projectId ? { projectId } : {}),
          ...(type ? { type } : {}),
          ...(assigneeId ? { assigneeId } : {}),
          subtype: { not: ArtifactSubtype.Template },
        },
        orderBy: { createdAt: "desc" },
      })
    );
  },
};
