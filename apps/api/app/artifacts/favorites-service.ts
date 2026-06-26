import type { Artifact } from "@repo/api/src/types/artifact";
import type { BasicUser } from "@repo/api/src/types/user";
import type { TransactionClient } from "@repo/database";
import { withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

function toArtifact(row: {
  id: string;
  organizationId: string;
  projectId: string | null;
  type: string;
  subtype: string | null;
  name: string;
  slug: string | null;
  status: string;
  priority: string | null;
  assigneeId: string | null;
  assignee: BasicUser | null;
  dueDate: Date | null;
  externalUrl: string | null;
  sortOrder: number | null;
  createdAt: Date;
  createdById: string | null;
  updatedAt: Date;
}): Artifact {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    type: row.type as Artifact["type"],
    subtype: row.subtype as Artifact["subtype"],
    name: row.name,
    slug: row.slug,
    status: row.status,
    priority: row.priority as Artifact["priority"],
    assigneeId: row.assigneeId,
    assignee: row.assignee,
    dueDate: row.dueDate,
    externalUrl: row.externalUrl,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    createdById: row.createdById,
    updatedAt: row.updatedAt,
  };
}

/**
 * Verify the artifact belongs to the given organization.
 * Returns `true` if it exists, `false` otherwise.
 */
async function artifactBelongsToOrg(
  db: TransactionClient,
  artifactId: string,
  organizationId: string
): Promise<boolean> {
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId, organizationId },
    select: { id: true },
  });
  return artifact !== null;
}

export const artifactFavoritesService = {
  /**
   * Add an artifact to the user's favorites (idempotent).
   */
  addFavorite(artifactId: string, userId: string, organizationId: string) {
    return withDb(async (db) => {
      if (!(await artifactBelongsToOrg(db, artifactId, organizationId))) {
        return null;
      }
      await db.favoriteArtifact.upsert({
        where: { userId_artifactId: { userId, artifactId } },
        create: { userId, artifactId },
        update: {},
      });
      return { favorited: true };
    });
  },

  /**
   * Remove an artifact from the user's favorites.
   */
  removeFavorite(artifactId: string, userId: string, organizationId: string) {
    return withDb(async (db) => {
      if (!(await artifactBelongsToOrg(db, artifactId, organizationId))) {
        return null;
      }
      await db.favoriteArtifact.deleteMany({
        where: { userId, artifactId },
      });
      return { favorited: false };
    });
  },

  /**
   * Find all favorite artifacts for a user within an organization.
   * Returns artifacts ordered by when they were favorited (newest first).
   */
  findFavoritesByUser(
    userId: string,
    organizationId: string
  ): Promise<Artifact[]> {
    return withDb(async (db) => {
      const favorites = await db.favoriteArtifact.findMany({
        where: {
          userId,
          artifact: { organizationId },
        },
        orderBy: { createdAt: "desc" },
        include: {
          artifact: {
            include: { assignee: basicUserSelect },
          },
        },
      });
      return favorites.map((f) => toArtifact(f.artifact));
    });
  },
};
