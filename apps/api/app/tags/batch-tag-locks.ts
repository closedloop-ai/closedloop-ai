import { Prisma, type TransactionClient } from "@repo/database";

type LockedIdRow = { id: string };

/**
 * Locks the organization-owned tag row for either batch tag mutation.
 *
 * `FOR KEY SHARE` is sufficient because both membership writes carry a foreign
 * key to this row and only need the referenced tag to survive the transaction.
 */
export async function lockBatchTag(
  tx: TransactionClient,
  tagId: string,
  organizationId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<LockedIdRow[]>(Prisma.sql`
    SELECT "id"
    FROM "tags"
    WHERE "id" = ${tagId}::uuid
      AND "organization_id" = ${organizationId}::uuid
    FOR KEY SHARE
  `);
  return rows.length > 0;
}

/**
 * Resolves organization-owned artifacts under the shared tag-mutation lock.
 *
 * `FOR KEY SHARE`, not the `FOR NO KEY UPDATE` its siblings take: tag writes
 * only need their referenced artifacts to survive. KEY SHARE therefore never
 * blocks — and is never blocked by — the status, priority and move batches'
 * `FOR NO KEY UPDATE`. `ORDER BY "id" ASC` keeps the lock order aligned with
 * those siblings (ISS-9440).
 */
export async function lockBatchTagArtifacts(
  tx: TransactionClient,
  artifactIds: readonly string[],
  organizationId: string
): Promise<Set<string>> {
  if (artifactIds.length === 0) {
    return new Set();
  }
  const artifactIdSql = Prisma.join(
    artifactIds.map((artifactId) => Prisma.sql`${artifactId}::uuid`)
  );
  const rows = await tx.$queryRaw<LockedIdRow[]>(Prisma.sql`
    SELECT "id"
    FROM "artifacts"
    WHERE "id" IN (${artifactIdSql})
      AND "organization_id" = ${organizationId}::uuid
    ORDER BY "id" ASC
    FOR KEY SHARE
  `);
  return new Set(rows.map((row) => row.id.toLowerCase()));
}

/**
 * Records the membership rows actually changed on the owning transaction.
 * `targetIds` is every resolved artifact the batch wrote to, changed or not,
 * for the per-artifact operation receipts (ISS-12552).
 */
export type RecordBatchTagReceipt = (
  tx: TransactionClient,
  changedIds: readonly string[],
  targetIds: readonly string[]
) => Promise<void>;
