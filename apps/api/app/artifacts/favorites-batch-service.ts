import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import type { BatchItemResult } from "@repo/api/src/types/batch-mutation-result";
import { Prisma, type TransactionClient } from "@repo/database";
import { batchResultsByFound } from "@/lib/batch-mutation-response";
import { normalizeUuid } from "@/lib/is-uuid";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

type LockedArtifact = { id: string };

/** The artifacts a favorite batch found, and the ones whose state it moved. */
export type FavoriteBatchWrite = {
  artifactIds: readonly string[];
  changedIds: readonly string[];
};

/** Set one favorite state for the caller's scoped artifact subset under lock. */
export async function batchSetArtifactFavorites(
  tx: TransactionClient,
  artifactIds: readonly string[],
  userId: string,
  organizationId: string,
  favorite: boolean,
  recordWrite?: RecordWriteInTransaction<FavoriteBatchWrite>
): Promise<Map<string, BatchItemResult>> {
  if (artifactIds.length > BATCH_MUTATION_ENTITY_LIMIT) {
    throw new RangeError("Favorite batch exceeds the entity limit");
  }
  const uniqueRequestedIds = [...new Set(artifactIds)];
  const normalizedIds = [...new Set(uniqueRequestedIds.map(normalizeUuid))];
  if (normalizedIds.length === 0) {
    return new Map();
  }
  const locked = await tx.$queryRaw<LockedArtifact[]>(Prisma.sql`
    SELECT "id" FROM "artifacts"
    WHERE "id" IN (${Prisma.join(normalizedIds.map((id) => Prisma.sql`${id}::uuid`))})
      AND "organization_id" = ${organizationId}::uuid
    ORDER BY "id" ASC
    FOR NO KEY UPDATE
  `);
  const foundIds = locked.map((row) => row.id);
  // ISS-12552: read only for a caller that records the write, so a write that
  // gets no receipt issues exactly the queries it did before.
  const alreadyFavorited = recordWrite
    ? await favoritedAmong(tx, userId, foundIds)
    : new Set<string>();
  if (foundIds.length > 0) {
    if (favorite) {
      await tx.favoriteArtifact.createMany({
        data: foundIds.map((artifactId) => ({ userId, artifactId })),
        skipDuplicates: true,
      });
    } else {
      await tx.favoriteArtifact.deleteMany({
        where: { userId, artifactId: { in: foundIds } },
      });
    }
  }
  await recordWrite?.(tx, {
    artifactIds: foundIds,
    changedIds: foundIds.filter(
      (artifactId) => alreadyFavorited.has(artifactId) !== favorite
    ),
  });
  return batchResultsByFound(
    uniqueRequestedIds,
    new Set(foundIds),
    normalizeUuid
  );
}

async function favoritedAmong(
  tx: TransactionClient,
  userId: string,
  artifactIds: readonly string[]
): Promise<Set<string>> {
  if (artifactIds.length === 0) {
    return new Set();
  }
  const rows = await tx.favoriteArtifact.findMany({
    where: { userId, artifactId: { in: [...artifactIds] } },
    select: { artifactId: true },
  });
  return new Set(rows.map((row) => row.artifactId));
}
