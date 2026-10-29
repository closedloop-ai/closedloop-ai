import type {
  Artifact,
  ArtifactSubtypeInput,
} from "@repo/api/src/types/artifact";
import { normalizeArtifactSubtype } from "@repo/api/src/types/artifact";
import type { BasicUser } from "@repo/api/src/types/user";
import type { TransactionClient } from "@repo/database";
import { withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";

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
    // FEA-3956: normalize the persisted subtype to its canonical value. Rows
    // never store the canonical `ISSUE` (map-in-code, PRD-560 dec. 2), but the
    // widened Prisma enum permits it; mapping keeps a skewed direct-write value
    // resolving to `FEATURE` instead of leaking `ISSUE` into the wire contract.
    subtype: row.subtype
      ? normalizeArtifactSubtype(row.subtype as ArtifactSubtypeInput)
      : null,
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

/** A favorite write's answer, and whether it changed the user's favorites. */
export type FavoriteWrite = { favorited: boolean; changed: boolean };

export const artifactFavoritesService = {
  /**
   * Add an artifact to the user's favorites (idempotent). Recorded, the
   * favorite and `recordWrite` share one transaction, so a receipt that cannot
   * be stored rolls the favorite back (ISS-12552); unrecorded, it is main's
   * autocommit upsert (flag-off parity).
   */
  addFavorite(
    artifactId: string,
    userId: string,
    organizationId: string,
    recordWrite?: RecordWriteInTransaction<FavoriteWrite>
  ) {
    return writeInShape(recordWrite, {
      unrecorded: () =>
        withDb(async (db) => {
          if (!(await artifactBelongsToOrg(db, artifactId, organizationId))) {
            return null;
          }
          await db.favoriteArtifact.upsert({
            where: { userId_artifactId: { userId, artifactId } },
            create: { userId, artifactId },
            update: {},
            select: { id: true },
          });
          return { favorited: true };
        }),
      recorded: (record) =>
        withDb.tx(async (tx) => {
          if (!(await artifactBelongsToOrg(tx, artifactId, organizationId))) {
            return null;
          }
          const { count } = await tx.favoriteArtifact.createMany({
            data: [{ userId, artifactId }],
            skipDuplicates: true,
          });
          await record(tx, { favorited: true, changed: count > 0 });
          return { favorited: true };
        }),
    });
  },

  /**
   * Remove an artifact from the user's favorites. Recorded, `recordWrite`
   * runs on the delete's transaction (ISS-12552); unrecorded, it is main's
   * autocommit delete.
   */
  removeFavorite(
    artifactId: string,
    userId: string,
    organizationId: string,
    recordWrite?: RecordWriteInTransaction<FavoriteWrite>
  ) {
    return writeInShape(recordWrite, {
      unrecorded: () =>
        withDb(async (db) => {
          if (!(await artifactBelongsToOrg(db, artifactId, organizationId))) {
            return null;
          }
          await db.favoriteArtifact.deleteMany({
            where: { userId, artifactId },
          });
          return { favorited: false };
        }),
      recorded: (record) =>
        withDb.tx(async (tx) => {
          if (!(await artifactBelongsToOrg(tx, artifactId, organizationId))) {
            return null;
          }
          const { count } = await tx.favoriteArtifact.deleteMany({
            where: { userId, artifactId },
          });
          await record(tx, { favorited: false, changed: count > 0 });
          return { favorited: false };
        }),
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
